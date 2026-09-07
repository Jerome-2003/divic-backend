const router = require("express").Router();
const User = require("../models/User");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logAction } = require("../services/audit");
const { ROLES } = require("../utils/constants");

router.use(requireAuth, requireRole("manager", "owner"));

router.get("/", async (req, res, next) => {
  try {
    // A manager cannot see or touch owner accounts.
    const filter = req.user.role === "owner" ? {} : { role: { $ne: "owner" } };
    const users = await User.find(filter).sort({ name: 1 });
    res.json(users.map((u) => ({ ...u.toSafeJSON(), lastLoginAt: u.lastLoginAt })));
  } catch (e) { next(e); }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, username, password, role, location, phone } = req.body;
    if (!name || !username || !password) {
      return res.status(400).json({ error: "A new account needs a name, username and starting password." });
    }
    if (!ROLES.includes(role)) return res.status(400).json({ error: "Choose a valid role." });
    if (password.length < 8) return res.status(400).json({ error: "The starting password needs at least 8 characters." });
    // Only an owner can mint managers or other owners.
    if (req.user.role === "manager" && !["receptionist", "cleaner"].includes(role)) {
      return res.status(403).json({ error: "Only the owner can create manager or owner accounts." });
    }
    if (location === "all" && !["manager", "owner"].includes(role)) {
      return res.status(400).json({ error: "Only managers and owners can cover both properties." });
    }

    const user = new User({ name, username: username.toLowerCase().trim(), role, location, phone });
    await user.setPassword(password);
    await user.save();

    logAction(req, { action: "Created a " + role + " account for " + name, entity: "User", entityId: user._id });
    res.status(201).json(user.toSafeJSON());
  } catch (e) { next(e); }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "That account does not exist." });
    if (req.user.role === "manager" && user.role === "owner") {
      return res.status(403).json({ error: "Only the owner can change an owner account." });
    }

    const { name, role, location, phone, password, active } = req.body;
    if (name) user.name = name;
    if (phone !== undefined) user.phone = phone;
    if (role) {
      if (req.user.role === "manager" && !["receptionist", "cleaner"].includes(role)) {
        return res.status(403).json({ error: "Only the owner can assign manager or owner roles." });
      }
      user.role = role;
    }
    if (location) user.location = location;
    if (active !== undefined) {
      if (String(user._id) === req.user.id) {
        return res.status(400).json({ error: "You cannot deactivate your own account." });
      }
      user.active = active;
    }
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: "The new password needs at least 8 characters." });
      await user.setPassword(password);
    }
    await user.save();

    logAction(req, { action: "Updated the account for " + user.name, entity: "User", entityId: user._id });
    res.json(user.toSafeJSON());
  } catch (e) { next(e); }
});

module.exports = router;
