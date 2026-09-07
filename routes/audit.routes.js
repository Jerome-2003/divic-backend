const router = require("express").Router();
const AuditLog = require("../models/AuditLog");
const { requireAuth, requireRole } = require("../middleware/auth");

router.use(requireAuth, requireRole("manager", "owner"));

router.get("/", async (req, res, next) => {
  try {
    const { location, entity, userId, limit = 200 } = req.query;
    const filter = {};
    if (location && location !== "all") filter.location = location;
    if (entity) filter.entity = entity;
    if (userId) filter.user = userId;
    const rows = await AuditLog.find(filter).sort({ at: -1 }).limit(Math.min(Number(limit), 500)).lean();
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
