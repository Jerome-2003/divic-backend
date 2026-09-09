const router = require("express").Router();
const User = require("../models/User");
const Facility = require("../models/Facility");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logAction } = require("../services/audit");
const { ROLES } = require("../utils/constants");

router.use(requireAuth, requireRole("manager", "owner"));

/**
 * Resolves the facilities a user is being assigned to and checks every one of
 * them sits at that user's own property. A Divic Urban bartender must never be
 * assignable to a Divic 1 bar, so this returns an error string rather
 * than silently dropping the ones that do not belong.
 */
async function resolveAssignedFacilities(ids, location) {
  if (!Array.isArray(ids)) {
    return { error: "Send the assigned facilities as a list." };
  }
  const wanted = [...new Set(ids.map(String))];
  if (!wanted.length) return { ids: [] };
  if (!["exclusive", "urban"].includes(location)) {
    return { error: "Give this person a property before assigning them facilities." };
  }
  let found;
  try {
    found = await Facility.find({ _id: { $in: wanted } }).select("location name").lean();
  } catch {
    return { error: "One of those facilities is not a valid record." };
  }
  if (found.length !== wanted.length) {
    return { error: "One of those facilities does not exist." };
  }
  const wrong = found.find((f) => f.location !== location);
  if (wrong) {
    return { error: wrong.name + " is at the other property and cannot be assigned to this person." };
  }
  return { ids: found.map((f) => f._id) };
}

router.get("/", async (req, res, next) => {
  try {
    // A manager cannot see or touch owner accounts.
    const filter = req.user.role === "owner" ? {} : { role: { $ne: "owner" } };
    const users = await User.find(filter).sort({ name: 1 });
    res.json(users.map((u) => ({
      ...u.toSafeJSON(),
      lastLoginAt: u.lastLoginAt,
      failedLoginAttempts: u.failedLoginAttempts || 0,
      loginLocked: Boolean(u.loginLockedAt),
      loginLockedAt: u.loginLockedAt || null,
    })));
  } catch (e) { next(e); }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, username, password, role, location, phone, assignedFacilities } = req.body;
    if (!name || !username || !password) {
      return res.status(400).json({ error: "A new account needs a name, username and starting password." });
    }
    if (!ROLES.includes(role)) return res.status(400).json({ error: "Choose a valid role." });
    if (password.length < 8) return res.status(400).json({ error: "The starting password needs at least 8 characters." });
    // Only an owner can mint managers or other owners. Facility staff are a
    // manager's to create.
    if (req.user.role === "manager" && !["receptionist", "cleaner", "facility"].includes(role)) {
      return res.status(403).json({ error: "Only the owner can create manager or owner accounts." });
    }
    if (location === "all" && !["manager", "owner", "receptionist"].includes(role)) {
      return res.status(400).json({ error: "Managers, owners, and receptionists can cover both properties." });
    }

    let assigned = [];
    if (role === "facility") {
      const check = await resolveAssignedFacilities(assignedFacilities || [], location);
      if (check.error) return res.status(400).json({ error: check.error });
      assigned = check.ids;
    } else if (assignedFacilities && assignedFacilities.length) {
      return res.status(400).json({ error: "Only facility staff can be assigned to facilities." });
    }

    const user = new User({
      name, username: username.toLowerCase().trim(), role, location, phone,
      assignedFacilities: assigned,
    });
    await user.setPassword(password);
    await user.save();

    logAction(req, { action: "Created a " + role + " account for " + name, entity: "User", entityId: user._id });
    res.status(201).json(user.toSafeJSON());
  } catch (e) { next(e); }
});

router.post("/:id/unlock-login", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "That account does not exist." });

    // A manager may unlock operational staff but not an owner account.
    if (req.user.role === "manager" && user.role === "owner") {
      return res.status(403).json({ error: "Only the owner can unlock an owner account." });
    }

    const wasLocked = Boolean(user.loginLockedAt || user.failedLoginAttempts);
    user.failedLoginAttempts = 0;
    user.loginLockedAt = undefined;
    user.loginUnlockedAt = new Date();
    await user.save();

    logAction(req, {
      action: "Granted login access to " + user.name,
      entity: "User",
      entityId: user._id,
      location: user.location,
      after: { loginAccessGranted: true, wasLocked },
    });

    res.json({
      ok: true,
      message: user.name + " can sign in again.",
      user: {
        ...user.toSafeJSON(),
        failedLoginAttempts: 0,
        loginLocked: false,
        loginLockedAt: null,
        loginUnlockedAt: user.loginUnlockedAt,
      },
    });
  } catch (e) { next(e); }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "That account does not exist." });
    if (req.user.role === "manager" && user.role === "owner") {
      return res.status(403).json({ error: "Only the owner can change an owner account." });
    }

    const { name, role, location, phone, password, active, assignedFacilities } = req.body;
    if (name) user.name = name;
    if (phone !== undefined) user.phone = phone;
    if (role) {
      if (req.user.role === "manager" && !["receptionist", "cleaner", "facility"].includes(role)) {
        return res.status(403).json({ error: "Only the owner can assign manager or owner roles." });
      }
      user.role = role;
    }
    if (location) user.location = location;

    // Same rule POST enforces: "all" is a manager and owner privilege. Checked
    // against the role the account ENDS UP with, because role and location can
    // change in one request — without this, editing a manager down to
    // receptionist leaves location "all" behind and scopeLocation then lets
    // them read both properties.
    if (user.location === "all" && !["manager", "owner", "receptionist"].includes(user.role)) {
      return res.status(400).json({ error: "Managers, owners, and receptionists can cover both properties." });
    }

    // Validate the assignment against whatever role and property the account
    // ends up with, not the ones it had when the request arrived.
    if (user.role === "facility") {
      if (user.location === "all") {
        return res.status(400).json({ error: "Facility staff work at one property, not both." });
      }
      if (assignedFacilities !== undefined || location) {
        const check = await resolveAssignedFacilities(
          assignedFacilities !== undefined ? assignedFacilities : user.assignedFacilities.map(String),
          user.location
        );
        if (check.error) return res.status(400).json({ error: check.error });
        user.assignedFacilities = check.ids;
      }
    } else {
      // Moving somebody off the facility role drops their tills with it.
      if (assignedFacilities && assignedFacilities.length) {
        return res.status(400).json({ error: "Only facility staff can be assigned to facilities." });
      }
      user.assignedFacilities = [];
    }

    if (active !== undefined) {
      if (String(user._id) === req.user.id) {
        return res.status(400).json({ error: "You cannot deactivate your own account." });
      }
      user.active = active;
    }
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: "The new password needs at least 8 characters." });
      await user.setPassword(password);
      // An authorised password reset also restores login access.
      user.failedLoginAttempts = 0;
      user.loginLockedAt = undefined;
      user.loginUnlockedAt = new Date();
    }
    await user.save();

    logAction(req, { action: "Updated the account for " + user.name, entity: "User", entityId: user._id });
    res.json(user.toSafeJSON());
  } catch (e) { next(e); }
});

module.exports = router;
