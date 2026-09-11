const router = require("express").Router();
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const { requireAuth } = require("../middleware/auth");
const { PERMISSIONS } = require("../utils/constants");
const { logAction } = require("../services/audit");

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  message: { error: "Too many sign-in attempts. Wait ten minutes and try again." },
});

router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Enter your username and password." });
    }

    const normalizedUsername = String(username).toLowerCase().trim();
    const user = await User.findOne({ username: normalizedUsername });

    // Same message either way so the form cannot be used to discover usernames.
    if (!user) {
      return res.status(401).json({ error: "That username and password don't match an account." });
    }

    if (user.loginLockedAt) {
      return res.status(423).json({
        error: "This account is locked after 5 failed password attempts.",
        locked: true,
        requiresManagerOrOwner: true,
      });
    }

    const passwordOk = await user.checkPassword(password);
    if (!passwordOk) {
      user.failedLoginAttempts = Math.min(5, (user.failedLoginAttempts || 0) + 1);

      if (user.failedLoginAttempts >= 5) {
        user.loginLockedAt = new Date();
        user.loginUnlockedAt = undefined;
        await user.save();

        logAction({ user: user.toSafeJSON(), headers: req.headers, ip: req.ip },
          { action: user.name + " was locked after 5 failed password attempts", entity: "User", entityId: user._id, location: user.location });

        return res.status(423).json({
          error: "This account is locked after 5 failed password attempts. A manager or owner must grant access before you can sign in again.",
          locked: true,
          requiresManagerOrOwner: true,
          attempts: 5,
        });
      }

      await user.save();
      const remaining = 5 - user.failedLoginAttempts;
      return res.status(401).json({
        error: "That username and password don't match an account.",
        attemptsRemaining: remaining,
      });
    }

    if (!user.active) {
      return res.status(403).json({ error: "This account has been deactivated. Speak to your manager." });
    }

    // Reception is intentionally cross-property. Persist the upgrade for
    // existing receptionist accounts so the rule applies immediately instead
    // of depending on an administrator editing every account by hand.
    if (user.role === "receptionist" && user.location !== "all") user.location = "all";

    // A successful sign-in clears the failed-attempt counter.
    user.failedLoginAttempts = 0;
    user.loginLockedAt = undefined;
    user.lastLoginAt = new Date();
    await user.save();

    const token = jwt.sign({ sub: String(user._id), role: user.role }, process.env.JWT_SECRET, { expiresIn: "12h" });
    logAction({ user: user.toSafeJSON(), headers: req.headers, ip: req.ip },
      { action: user.name + " signed in", entity: "User", entityId: user._id, location: user.location });

    res.json({ token, user: user.toSafeJSON(), permissions: PERMISSIONS[user.role] });
  } catch (e) { next(e); }
});

// Lets the account-management screen show which staff accounts need an
// authorised unlock. The actual unlock endpoint is in /api/staff because that
// router is already restricted to manager/owner accounts.

router.get("/me", requireAuth, async (req, res) => {
  res.json({ user: req.user, permissions: PERMISSIONS[req.user.role] });
});

// Marks the guided tour seen for this account, so it is not offered again on
// any device. Idempotent — setting it again just moves the timestamp.
router.put("/me/tour-seen", requireAuth, async (req, res, next) => {
  try {
    const tourSeenAt = new Date();
    await User.findByIdAndUpdate(req.user.id, { tourSeenAt });
    res.json({ tourSeenAt });
  } catch (e) { next(e); }
});

router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: "Your new password needs at least 8 characters." });
    }
    const user = await User.findById(req.user.id);
    if (!(await user.checkPassword(currentPassword))) {
      return res.status(401).json({ error: "Your current password is not correct." });
    }
    await user.setPassword(newPassword);
    await user.save();
    logAction(req, { action: "Changed their own password", entity: "User", entityId: user._id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
