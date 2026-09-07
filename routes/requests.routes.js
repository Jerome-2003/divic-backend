const router = require("express").Router();
const BookingRequest = require("../models/BookingRequest");
const Booking = require("../models/Booking");
const Guest = require("../models/Guest");
const Room = require("../models/Room");
const { requireAuth, requireModule, scopeLocation } = require("../middleware/auth");
const { findAvailableRooms } = require("../services/availability");
const { logAction } = require("../services/audit");

// Staff-side handling of website requests.
router.use(requireAuth, requireModule("bookings"));

router.get("/", scopeLocation, async (req, res, next) => {
  try {
    const status = req.query.status || "pending";
    const reqs = await BookingRequest.find({ location: req.location, status })
      .sort({ createdAt: 1 }).limit(200).lean();

    // Tell the receptionist straight away whether each one can be accepted.
    const out = [];
    for (const r of reqs) {
      const free = await findAvailableRooms(req.location, r.checkIn, r.checkOut, { roomType: r.roomType });
      out.push({ ...r, freeRooms: free.map((f) => ({ number: f.number, floor: f.floor })), canAccept: free.length > 0 });
    }
    res.json(out);
  } catch (e) { next(e); }
});

router.post("/:id/accept", async (req, res, next) => {
  try {
    const reqDoc = await BookingRequest.findById(req.params.id);
    if (!reqDoc) return res.status(404).json({ error: "That request does not exist." });
    if (reqDoc.status !== "pending") {
      return res.status(409).json({ error: "This request has already been " + reqDoc.status + "." });
    }
    if (req.user.location !== "all" && reqDoc.location !== req.user.location) {
      return res.status(403).json({ error: "You can only work on your own property." });
    }

    const free = await findAvailableRooms(reqDoc.location, reqDoc.checkIn, reqDoc.checkOut, { roomType: reqDoc.roomType });
    const chosen = req.body.roomNumber
      ? free.find((f) => f.number === req.body.roomNumber)
      : free[0];
    if (!chosen) {
      return res.status(409).json({ error: "No " + reqDoc.roomType + " room is free for those dates. Decline the request or offer another type." });
    }

    let guest = await Guest.findOne({ phone: reqDoc.guestPhone });
    if (!guest) {
      guest = await Guest.create({
        name: reqDoc.guestName, phone: reqDoc.guestPhone, email: reqDoc.guestEmail,
      });
    }

    const room = await Room.findById(chosen._id);
    const prefix = reqDoc.location === "exclusive" ? "DX-" : "DU-";
    const booking = await Booking.create({
      ref: prefix + Math.floor(1000 + Math.random() * 9000),
      location: reqDoc.location, guest: guest._id,
      room: room._id, roomNumber: room.number, roomType: reqDoc.roomType,
      checkIn: reqDoc.checkIn, checkOut: reqDoc.checkOut, nights: reqDoc.nights,
      rate: reqDoc.quotedRate, totalCharge: reqDoc.quotedTotal,
      adults: reqDoc.adults, children: reqDoc.children,
      source: "website", specialRequests: reqDoc.specialRequests,
      createdBy: req.user.id, fromRequest: reqDoc._id,
    });

    reqDoc.status = "accepted";
    reqDoc.handledBy = req.user.id;
    reqDoc.handledAt = new Date();
    reqDoc.booking = booking._id;
    await reqDoc.save();

    logAction(req, {
      action: "Accepted website request " + reqDoc.reference + " as booking " + booking.ref + " in room " + room.number,
      entity: "BookingRequest", entityId: reqDoc._id, location: reqDoc.location,
    });
    req.app.get("io")?.to("loc:" + reqDoc.location).emit("booking:created", booking);
    res.json({ request: reqDoc, booking });
  } catch (e) { next(e); }
});

router.post("/:id/decline", async (req, res, next) => {
  try {
    const reqDoc = await BookingRequest.findById(req.params.id);
    if (!reqDoc) return res.status(404).json({ error: "That request does not exist." });
    if (reqDoc.status !== "pending") {
      return res.status(409).json({ error: "This request has already been " + reqDoc.status + "." });
    }
    reqDoc.status = "declined";
    reqDoc.declineReason = req.body.reason;
    reqDoc.handledBy = req.user.id;
    reqDoc.handledAt = new Date();
    await reqDoc.save();

    logAction(req, {
      action: "Declined website request " + reqDoc.reference,
      entity: "BookingRequest", entityId: reqDoc._id, location: reqDoc.location,
    });
    res.json(reqDoc);
  } catch (e) { next(e); }
});

module.exports = router;
