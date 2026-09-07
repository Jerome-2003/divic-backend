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
    const user = await User.findOne({ username: String(username).toLowerCase().trim() });
    // Same message either way so the form cannot be used to discover usernames.
    if (!user || !(await user.checkPassword(password))) {
      return res.status(401).json({ error: "That username and password don't match an account." });
    }
    if (!user.active) {
      return res.status(403).json({ error: "This account has been deactivated. Speak to your manager." });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = jwt.sign({ sub: String(user._id), role: user.role }, process.env.JWT_SECRET, { expiresIn: "12h" });
    logAction({ user: user.toSafeJSON(), headers: req.headers, ip: req.ip },
      { action: user.name + " signed in", entity: "User", entityId: user._id, location: user.location });

    res.json({ token, user: user.toSafeJSON(), permissions: PERMISSIONS[user.role] });
  } catch (e) { next(e); }
});

router.get("/me", requireAuth, async (req, res) => {
  res.json({ user: req.user, permissions: PERMISSIONS[req.user.role] });
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
