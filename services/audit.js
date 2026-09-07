const AuditLog = require("../models/AuditLog");
const { durableWrite } = require("./durableWrite");

// Audit writes must never break the request they describe, so they go through
// durableWrite and are not awaited by the caller's critical path.
function logAction(req, { action, entity, entityId, location, before, after }) {
  const payload = {
    at: new Date(),
    user: req.user ? req.user.id : undefined,
    userName: req.user ? req.user.name : "Public",
    role: req.user ? req.user.role : "public",
    location: location || (req.user ? req.user.location : undefined),
    action, entity, entityId, before, after,
    ip: req.headers["x-forwarded-for"] || req.ip,
  };
  durableWrite("AuditLog", payload.location, payload, () => AuditLog.create(payload));
}

module.exports = { logAction };
