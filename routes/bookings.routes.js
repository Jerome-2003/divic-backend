const router = require("express").Router();
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Room = require("../models/Room");
const Guest = require("../models/Guest");
const Rate = require("../models/Rate");
const { requireAuth, requireModule, requireOperational, scopeLocation } = require("../middleware/auth");
const { isRoomAvailable, validRange, nightsBetween } = require("../services/availability");
const { logAction } = require("../services/audit");
const { foliosFor, folioFor } = require("../services/folio");
const { LOCATIONS } = require("../utils/constants");

router.use(requireAuth, requireModule("bookings"));

const today = () => new Date().toISOString().slice(0, 10);

async function makeRef(location) {
  const prefix = location === "exclusive" ? "DX-" : "DU-";
  for (let i = 0; i < 5; i++) {
    const ref = prefix + Math.floor(1000 + Math.random() * 9000);
    if (!(await Booking.exists({ ref }))) return ref;
  }
  return prefix + Date.now().toString().slice(-6);
}

router.get("/", scopeLocation, async (req, res, next) => {
  try {
    const { status, from, to, q, limit = 100 } = req.query;
    const filter = { location: req.location };
    if (status) filter.status = status;
    if (from) filter.checkOut = { $gte: from };
    if (to) filter.checkIn = { $lte: to };

    let bookings = await Booking.find(filter)
      .populate("guest", "name phone email")
      .sort({ checkIn: -1 })
      .limit(Math.min(Number(limit), 500))
      .lean();

    if (q) {
      const needle = String(q).toLowerCase();
      bookings = bookings.filter((b) =>
        (b.ref + " " + b.roomNumber + " " + (b.guest?.name || "") + " " + (b.guest?.phone || ""))
          .toLowerCase().includes(needle));
    }

    // The balance is the room plus anything charged to it at a facility, less
    // what has been paid — see services/folio.js.
    const folios = await foliosFor(bookings);

    res.json(bookings.map((b) => {
      const f = folios[String(b._id)];
      return {
        ...b,
        roomCharges: f.roomCharges,
        facilityCharges: f.facilityCharges,
        totalCharges: f.totalCharges,
        paid: f.paid,
        balance: f.balance,
      };
    }));
  } catch (e) { next(e); }
});

router.post("/", scopeLocation, requireOperational("receptionist"), async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const {
      guestId, guest: newGuest, roomNumber, roomType,
      checkIn, checkOut, adults = 1, children = 0,
      source = "walk-in", specialRequests,
    } = req.body;

    const bad = validRange(checkIn, checkOut);
    if (bad) return res.status(400).json({ error: bad });

    const room = await Room.findOne({ location: req.location, number: roomNumber });
    if (!room) return res.status(404).json({ error: "Room " + roomNumber + " does not exist at this property." });
    if (room.status === "maintenance") {
      return res.status(409).json({ error: "Room " + roomNumber + " is out of order and cannot be booked." });
    }

    let created;
    // A transaction is what actually stops a double booking: the availability
    // check and the insert have to be one atomic step, or a walk-in and a
    // website request can both pass the check a millisecond apart.
    await session.withTransaction(async () => {
      const free = await isRoomAvailable(req.location, roomNumber, checkIn, checkOut);
      if (!free) {
        const err = new Error("Room " + roomNumber + " is already booked for part of those dates.");
        err.status = 409; err.expose = true;
        throw err;
      }

      let guestDoc;
      if (guestId) {
        guestDoc = await Guest.findById(guestId).session(session);
        if (!guestDoc) { const e = new Error("That guest record was not found."); e.status = 404; e.expose = true; throw e; }
      } else {
        if (!newGuest || !newGuest.name || !newGuest.phone) {
          const e = new Error("A new guest needs at least a name and a phone number.");
          e.status = 400; e.expose = true; throw e;
        }
        const existing = await Guest.findOne({ phone: newGuest.phone.trim() }).session(session);
        guestDoc = existing || (await Guest.create([{ ...newGuest }], { session }))[0];
      }

      const rateDoc = await Rate.findOne({ location: req.location }).session(session).lean();
      const prices = rateDoc ? Object.fromEntries(Object.entries(rateDoc.prices)) : LOCATIONS[req.location].rates;
      const rate = prices[roomType || room.type];
      const n = nightsBetween(checkIn, checkOut);

      created = (await Booking.create([{
        ref: await makeRef(req.location),
        location: req.location,
        guest: guestDoc._id,
        room: room._id, roomNumber: room.number, roomType: roomType || room.type,
        checkIn, checkOut, nights: n,
        rate, totalCharge: rate * n,
        adults, children, source, specialRequests,
        createdBy: req.user.id,
      }], { session }))[0];
    });

    await created.populate("guest", "name phone email");
    logAction(req, {
      action: (req.isOverride ? "OVERRIDE — " : "") +
        "Created booking " + created.ref + " for " + created.guest.name + " in room " + created.roomNumber +
        (req.isOverride ? " (" + req.body.overrideReason + ")" : ""),
      entity: "Booking", entityId: created._id, location: req.location, after: created.toObject(),
    });
    req.app.get("io")?.to("loc:" + req.location).emit("booking:created", created);
    res.status(201).json(created);
  } catch (e) { next(e); } finally { session.endSession(); }
});

router.post("/:id/check-in", requireOperational("receptionist"), async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id).populate("guest", "name");
    if (!booking) return res.status(404).json({ error: "That booking does not exist." });
    if (req.user.location !== "all" && booking.location !== req.user.location) {
      return res.status(403).json({ error: "You can only work on your own property." });
    }
    if (booking.status !== "confirmed") {
      return res.status(409).json({ error: "Only a confirmed booking can be checked in. This one is " + booking.status + "." });
    }
    booking.status = "in-house";
    booking.checkedInAt = new Date();
    await booking.save();
    await Room.updateOne({ _id: booking.room }, { status: "occupied" });

    logAction(req, {
      action: (req.isOverride ? "OVERRIDE — " : "") +
        "Checked in " + booking.guest.name + " to room " + booking.roomNumber +
        (req.isOverride ? " (" + req.body.overrideReason + ")" : ""),
      entity: "Booking", entityId: booking._id, location: booking.location,
    });
    req.app.get("io")?.to("loc:" + booking.location).emit("booking:updated", booking);
    res.json(booking);
  } catch (e) { next(e); }
});

router.post("/:id/check-out", requireOperational("receptionist"), async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id).populate("guest", "name");
    if (!booking) return res.status(404).json({ error: "That booking does not exist." });
    if (req.user.location !== "all" && booking.location !== req.user.location) {
      return res.status(403).json({ error: "You can only work on your own property." });
    }
    if (booking.status !== "in-house") {
      return res.status(409).json({ error: "Only a guest who is in house can be checked out." });
    }

    // An unpaid bar tab is as much of a balance as an unpaid room, so the guard
    // has to look at the whole folio, not just Booking.totalCharge.
    const folio = await folioFor(booking);
    const balance = folio.balance;
    if (balance > 0 && !req.body.allowUnpaid) {
      return res.status(409).json({
        error: "This folio still has an outstanding balance.",
        balance,
        roomCharges: folio.roomCharges,
        facilityCharges: folio.facilityCharges,
        paid: folio.paid,
        hint: "Take the payment first, or send allowUnpaid to check out with the balance owing.",
      });
    }

    booking.status = "checked-out";
    booking.checkedOutAt = new Date();
    await booking.save();
    // Checkout sends the room to housekeeping automatically — the front desk
    // must not be able to sell a room that has not been turned over.
    await Room.updateOne({ _id: booking.room }, { status: "dirty" });

    logAction(req, {
      action: (req.isOverride ? "OVERRIDE — " : "") +
        "Checked out " + booking.guest.name + " from room " + booking.roomNumber +
        (balance > 0 ? " with " + balance + " naira owing" : "") +
        (req.isOverride ? " (" + req.body.overrideReason + ")" : ""),
      entity: "Booking", entityId: booking._id, location: booking.location,
    });
    req.app.get("io")?.to("loc:" + booking.location).emit("booking:updated", booking);
    res.json({ booking, balance, folio });
  } catch (e) { next(e); }
});

router.post("/:id/cancel", async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id).populate("guest", "name");
    if (!booking) return res.status(404).json({ error: "That booking does not exist." });
    if (booking.status === "checked-out") {
      return res.status(409).json({ error: "A completed stay cannot be cancelled." });
    }
    if (booking.status === "in-house") {
      await Room.updateOne({ _id: booking.room }, { status: "dirty" });
    }
    booking.status = "cancelled";
    booking.cancelledAt = new Date();
    booking.cancelReason = req.body.reason;
    await booking.save();

    logAction(req, {
      action: "Cancelled booking " + booking.ref + " for " + booking.guest.name,
      entity: "Booking", entityId: booking._id, location: booking.location,
    });
    req.app.get("io")?.to("loc:" + booking.location).emit("booking:updated", booking);
    res.json(booking);
  } catch (e) { next(e); }
});

/**
 * Moves a booking to a different room, or places a paid booking that arrived
 * with no room because everything was taken during checkout.
 *
 * Availability is re-checked here rather than trusted from the client: the list
 * the receptionist is looking at may be seconds out of date.
 */
router.patch("/:id/room", async (req, res, next) => {
  try {
    const { roomNumber, reason } = req.body;
    if (!roomNumber) return res.status(400).json({ error: "Choose a room to move this booking to." });

    const booking = await Booking.findById(req.params.id).populate("guest", "name");
    if (!booking) return res.status(404).json({ error: "That booking does not exist." });
    if (req.user.location !== "all" && booking.location !== req.user.location) {
      return res.status(403).json({ error: "You can only work on your own property." });
    }
    if (["checked-out", "cancelled"].includes(booking.status)) {
      return res.status(409).json({ error: "A booking that is " + booking.status + " cannot be moved." });
    }

    const room = await Room.findOne({ location: booking.location, number: roomNumber });
    if (!room) return res.status(404).json({ error: "Room " + roomNumber + " does not exist at this property." });
    if (room.status === "maintenance") {
      return res.status(409).json({ error: "Room " + roomNumber + " is out of order." });
    }

    const free = await isRoomAvailable(booking.location, roomNumber, booking.checkIn, booking.checkOut, booking._id);
    if (!free) {
      return res.status(409).json({ error: "Room " + roomNumber + " is already booked for part of those dates." });
    }

    const previous = booking.roomNumber || null;

    // A guest who is already in house is physically in the old room, so free
    // the old one for cleaning and take the new one straight to occupied.
    if (booking.status === "in-house") {
      if (booking.room) await Room.updateOne({ _id: booking.room }, { status: "dirty" });
      await Room.updateOne({ _id: room._id }, { status: "occupied" });
    }

    booking.room = room._id;
    booking.roomNumber = room.number;
    booking.roomType = room.type;
    booking.autoAssigned = false;
    booking.needsAttention = false;
    booking.attentionReason = undefined;
    booking.roomChanges.push({ from: previous, to: room.number, reason, by: req.user.id });
    await booking.save();

    logAction(req, {
      action: previous
        ? "Moved " + booking.guest.name + " from room " + previous + " to " + room.number + (reason ? " — " + reason : "")
        : "Placed " + booking.guest.name + " in room " + room.number + " (booking had no room)",
      entity: "Booking", entityId: booking._id, location: booking.location,
      before: { roomNumber: previous }, after: { roomNumber: room.number },
    });
    req.app.get("io")?.to("loc:" + booking.location).emit("booking:updated", booking);
    res.json(booking);
  } catch (e) { next(e); }
});

module.exports = router;
