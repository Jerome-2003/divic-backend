const router = require("express").Router();
const Notification = require("../models/Notification");
const { requireAuth, requireModule, scopeLocation } = require("../middleware/auth");

router.use(requireAuth, requireModule("notifications"));

/** Recent alerts for the property being viewed, newest first. */
router.get("/", scopeLocation, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 40, 100);
    const rows = await Notification.find({ location: req.location })
      .sort({ createdAt: -1 }).limit(limit).lean();

    res.json({
      location: req.location,
      unread: rows.filter((n) => !n.readBy.some((id) => String(id) === req.user.id)).length,
      notifications: rows.map((n) => ({
        ...n,
        read: n.readBy.some((id) => String(id) === req.user.id),
        readBy: undefined,   // who else has read it is nobody's business here
      })),
    });
  } catch (e) { next(e); }
});

// Read state is per user, not global — one receptionist clearing an alert must
// not hide it from the next person on shift.
router.post("/:id/read", async (req, res, next) => {
  try {
    const n = await Notification.findByIdAndUpdate(
      req.params.id,
      { $addToSet: { readBy: req.user.id } },
      { new: true }
    );
    if (!n) return res.status(404).json({ error: "That notification does not exist." });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post("/read-all", scopeLocation, async (req, res, next) => {
  try {
    await Notification.updateMany(
      { location: req.location, readBy: { $ne: req.user.id } },
      { $addToSet: { readBy: req.user.id } }
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
