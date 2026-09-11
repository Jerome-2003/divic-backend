const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Facility = require("../models/Facility");
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
      assignedFacilities: (user.assignedFacilities || []).map(String),
      tourSeenAt: user.tourSeenAt || null,
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

/**
 * Facility scoping. Loads the facility named by a route parameter (":facilityId"
 * by default) and pins it on req.facility, then checks the signed-in user may
 * work there. Managers and owners pass automatically, subject to the same
 * property scoping as everywhere else; a facility user must have the facility
 * in their assignedFacilities or they get a 403.
 */
const requireAssignedFacility = (param = "facilityId") => async (req, res, next) => {
  try {
    const facility = await Facility.findById(req.params[param]);
    if (!facility) return res.status(404).json({ error: "That facility does not exist." });
    if (req.user.location !== "all" && facility.location !== req.user.location) {
      return res.status(403).json({ error: "You can only work on your own property." });
    }
    if (req.user.role === "facility" && !req.user.assignedFacilities.includes(String(facility._id))) {
      return res.status(403).json({ error: "You are not assigned to " + facility.name + "." });
    }
    req.facility = facility;
    req.location = facility.location;
    next();
  } catch (e) { next(e); }
};

/**
 * Lets the named operational role(s) act freely — this is their routine work,
 * done many times a day, and it stays a single tap for them.
 *
 * Owner and manager can also perform the action, but only by sending
 * { override: true, overrideReason: "..." } in the body, and it is logged
 * distinctly. The point is not to keep them out — an owner locked out of
 * checking in a guest when the desk is empty is a worse outcome than an owner
 * who can, but has to say why. A receptionist's tenth check-in of the day and
 * an owner's once-a-month emergency check-in should not look identical in the
 * activity log afterwards.
 */
function requireOperational(...operationalRoles) {
  return (req, res, next) => {
    if (operationalRoles.includes(req.user.role)) return next();
    if (["owner", "manager"].includes(req.user.role)) {
      if (!req.body || req.body.override !== true) {
        return res.status(403).json({
          error: "This is normally done by " + operationalRoles.join(" or ") +
            ". Use the override option if you need to do it yourself right now.",
          requiresOverride: true,
        });
      }
      if (!req.body.overrideReason || !req.body.overrideReason.trim()) {
        return res.status(400).json({ error: "Give a short reason for the override." });
      }
      req.isOverride = true;
      return next();
    }
    return res.status(403).json({ error: "Your role does not have access to this." });
  };
}

module.exports = {
  requireAuth, requireModule, requireRole, scopeLocation, requireAssignedFacility,
  requireOperational,
};
