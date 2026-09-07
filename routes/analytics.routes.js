const router = require("express").Router();
const Booking = require("../models/Booking");
const Room = require("../models/Room");
const Payment = require("../models/Payment");
const { requireAuth, requireRole, scopeLocation } = require("../middleware/auth");

// Revenue and analytics are manager and owner only. Receptionists never see them.
router.use(requireAuth, requireRole("manager", "owner"));

const today = () => new Date().toISOString().slice(0, 10);
const shift = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

router.get("/summary", scopeLocation, async (req, res, next) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 365);
    const from = shift(today(), -days);

    const rooms = await Room.countDocuments({ location: req.location });
    const bookings = await Booking.find({
      location: req.location, status: { $ne: "cancelled" }, checkIn: { $gte: from },
    }).lean();

    const roomNights = bookings.reduce((s, b) => s + b.nights, 0);
    const revenue = bookings.reduce((s, b) => s + b.totalCharge, 0);
    const available = rooms * days;

    const byType = {};
    bookings.forEach((b) => {
      byType[b.roomType] = byType[b.roomType] || { bookings: 0, nights: 0, revenue: 0 };
      byType[b.roomType].bookings++;
      byType[b.roomType].nights += b.nights;
      byType[b.roomType].revenue += b.totalCharge;
    });

    const bySource = {};
    bookings.forEach((b) => {
      bySource[b.source] = (bySource[b.source] || 0) + 1;
    });

    const collected = await Payment.aggregate([
      { $match: { location: req.location, voided: false, createdAt: { $gte: new Date(from) } } },
      { $group: { _id: "$method", total: { $sum: "$amount" } } },
    ]);

    res.json({
      location: req.location, period: { from, to: today(), days },
      totalRooms: rooms, roomNightsSold: roomNights, roomNightsAvailable: available,
      occupancyPercent: available ? Math.round((roomNights / available) * 100) : 0,
      averageDailyRate: roomNights ? Math.round(revenue / roomNights) : 0,
      revPAR: available ? Math.round(revenue / available) : 0,
      totalRoomRevenue: revenue,
      byRoomType: byType, bySource,
      collectedByMethod: Object.fromEntries(collected.map((c) => [c._id, c.total])),
    });
  } catch (e) { next(e); }
});

/** Night-by-night occupancy, for the chart. */
router.get("/occupancy", scopeLocation, async (req, res, next) => {
  try {
    const back = Math.min(Number(req.query.back) || 7, 60);
    const forward = Math.min(Number(req.query.forward) || 7, 60);
    const rooms = await Room.countDocuments({ location: req.location, status: { $ne: "maintenance" } });
    const start = shift(today(), -back);
    const end = shift(today(), forward);

    const bookings = await Booking.find({
      location: req.location, status: { $ne: "cancelled" },
      checkIn: { $lt: end }, checkOut: { $gt: start },
    }).select("checkIn checkOut totalCharge nights rate").lean();

    const nights = [];
    for (let i = -back; i <= forward; i++) {
      const d = shift(today(), i);
      const staying = bookings.filter((b) => b.checkIn <= d && b.checkOut > d);
      nights.push({
        date: d,
        roomsSold: staying.length,
        occupancyPercent: rooms ? Math.round((staying.length / rooms) * 100) : 0,
        roomRevenue: staying.reduce((s, b) => s + b.rate, 0),
        isFuture: i > 0,
      });
    }
    res.json({ location: req.location, sellableRooms: rooms, nights });
  } catch (e) { next(e); }
});

/** Both properties side by side. They stay separate — nothing is pooled. */
router.get("/compare", async (req, res, next) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 365);
    const from = shift(today(), -days);
    const out = {};
    for (const location of ["exclusive", "urban"]) {
      const rooms = await Room.countDocuments({ location });
      const bookings = await Booking.find({ location, status: { $ne: "cancelled" }, checkIn: { $gte: from } }).lean();
      const roomNights = bookings.reduce((s, b) => s + b.nights, 0);
      const revenue = bookings.reduce((s, b) => s + b.totalCharge, 0);
      const available = rooms * days;
      out[location] = {
        totalRooms: rooms, roomNightsSold: roomNights,
        occupancyPercent: available ? Math.round((roomNights / available) * 100) : 0,
        averageDailyRate: roomNights ? Math.round(revenue / roomNights) : 0,
        revPAR: available ? Math.round(revenue / available) : 0,
        totalRoomRevenue: revenue, bookings: bookings.length,
      };
    }
    res.json({ period: { from, to: today(), days }, properties: out });
  } catch (e) { next(e); }
});

module.exports = router;
