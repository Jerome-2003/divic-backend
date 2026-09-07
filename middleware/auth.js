const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { PERMISSIONS } = require("../utils/constants");

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sign in to continue." });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user || !user.active) {
      return res.status(401).json({ error: "This account is no longer active." });
    }
    req.user = {
      id: String(user._id), name: user.name, role: user.role,
      location: user.location, username: user.username,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Your session has expired. Sign in again." });
  }
}

/** Gate by module key, matching PERMISSIONS in utils/constants.js */
const requireModule = (moduleKey) => (req, res, next) => {
  const allowed = PERMISSIONS[req.user.role] || [];
  if (!allowed.includes(moduleKey)) {
    return res.status(403).json({ error: "Your role does not have access to this." });
  }
  next();
};

/** Gate by explicit role list */
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: "Your role does not have access to this." });
  }
  next();
};

/**
 * Property scoping. Receptionists and cleaners are locked to their own address;
 * managers and owners may pass ?location= to switch. Reads req.query.location
 * or req.body.location and pins req.location.
 */
function scopeLocation(req, res, next) {
  const asked = req.query.location || req.body.location;
  if (req.user.location === "all") {
    if (asked && !["exclusive", "urban"].includes(asked)) {
      return res.status(400).json({ error: "Unknown property." });
    }
    req.location = asked || "exclusive";
    return next();
  }
  if (asked && asked !== req.user.location) {
    return res.status(403).json({ error: "You can only work on your own property." });
  }
  req.location = req.user.location;
  next();
}

module.exports = { requireAuth, requireModule, requireRole, scopeLocation };
