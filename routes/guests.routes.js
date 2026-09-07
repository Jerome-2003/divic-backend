const router = require("express").Router();
const Guest = require("../models/Guest");
const Booking = require("../models/Booking");
const { requireAuth, requireModule } = require("../middleware/auth");
const { logAction } = require("../services/audit");

router.use(requireAuth, requireModule("guests"));

router.get("/", async (req, res, next) => {
  try {
    const { q, limit = 100 } = req.query;
    const filter = q
      ? { $or: [
          { name: new RegExp(String(q).trim(), "i") },
          { phone: new RegExp(String(q).trim(), "i") },
          { email: new RegExp(String(q).trim(), "i") },
        ] }
      : {};
    const guests = await Guest.find(filter).sort({ name: 1 }).limit(Math.min(Number(limit), 300)).lean();

    const stats = await Booking.aggregate([
      { $match: { guest: { $in: guests.map((g) => g._id) }, status: { $ne: "cancelled" } } },
      { $group: { _id: "$guest", stays: { $sum: 1 }, nights: { $sum: "$nights" },
                  spend: { $sum: "$totalCharge" }, lastStay: { $max: "$checkIn" },
                  properties: { $addToSet: "$location" } } },
    ]);
    const by = Object.fromEntries(stats.map((s) => [String(s._id), s]));

    res.json(guests.map((g) => ({
      ...g,
      stays: by[String(g._id)]?.stays || 0,
      nights: by[String(g._id)]?.nights || 0,
      spend: by[String(g._id)]?.spend || 0,
      lastStay: by[String(g._id)]?.lastStay || null,
      properties: by[String(g._id)]?.properties || [],
    })));
  } catch (e) { next(e); }
});

router.get("/:id", async (req, res, next) => {
  try {
    const guest = await Guest.findById(req.params.id).lean();
    if (!guest) return res.status(404).json({ error: "That guest record does not exist." });
    const stays = await Booking.find({ guest: guest._id }).sort({ checkIn: -1 }).lean();
    res.json({ ...guest, stays });
  } catch (e) { next(e); }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "A guest needs at least a name and phone number." });
    const existing = await Guest.findOne({ phone: phone.trim() });
    if (existing) return res.status(409).json({ error: "A guest with that phone number already exists.", guest: existing });
    const guest = await Guest.create(req.body);
    logAction(req, { action: "Added guest " + guest.name, entity: "Guest", entityId: guest._id });
    res.status(201).json(guest);
  } catch (e) { next(e); }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const allowed = ["name", "phone", "email", "idType", "idNumber", "address", "notes"];
    const update = {};
    allowed.forEach((k) => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const guest = await Guest.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!guest) return res.status(404).json({ error: "That guest record does not exist." });
    logAction(req, { action: "Updated the record for " + guest.name, entity: "Guest", entityId: guest._id });
    res.json(guest);
  } catch (e) { next(e); }
});

module.exports = router;
