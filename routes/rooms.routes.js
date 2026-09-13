const router = require("express").Router();
const Room = require("../models/Room");
const Booking = require("../models/Booking");
const Rate = require("../models/Rate");
const Discount = require("../models/Discount");
const { requireAuth, requireModule, requireRole, scopeLocation } = require("../middleware/auth");
const { findAvailableRooms, validRange } = require("../services/availability");
const { logAction } = require("../services/audit");
const { ROOM_STATUSES, LOCATIONS } = require("../utils/constants");
const { publicDiscount } = require("../services/pricing");

router.use(requireAuth);

// The room board. Cleaners reach this too — it is the only module they have.
router.get("/", requireModule("rooms"), scopeLocation, async (req, res, next) => {
  try {
    const rooms = await Room.find({ location: req.location }).sort({ floor: 1, number: 1 }).lean();
    const inHouse = await Booking.find({ location: req.location, status: "in-house" })
      .populate("guest", "name").select("roomNumber guest checkIn checkOut ref").lean();
    const byRoom = Object.fromEntries(inHouse.map((b) => [b.roomNumber, b]));

    res.json(rooms.map((r) => ({
      ...r,
      occupant: byRoom[r.number]
        ? { name: byRoom[r.number].guest?.name, checkOut: byRoom[r.number].checkOut, ref: byRoom[r.number].ref }
        : null,
    })));
  } catch (e) { next(e); }
});

router.patch("/:id/status", requireModule("rooms"), async (req, res, next) => {
  try {
    const { status, note } = req.body;
    if (!ROOM_STATUSES.includes(status)) {
      return res.status(400).json({ error: "That is not a valid room status." });
    }
    const room = await Room.findById(req.params.id);
    if (!room) return res.status(404).json({ error: "That room does not exist." });
    if (req.user.location !== "all" && room.location !== req.user.location) {
      return res.status(403).json({ error: "You can only work on your own property." });
    }
    // Cleaners can move a room through the cleaning cycle but cannot mark a room
    // out of order — that is a maintenance decision.
    if (req.user.role === "cleaner" && !["cleaning", "available", "dirty"].includes(status)) {
      return res.status(403).json({ error: "Housekeeping can set a room to being cleaned, clean, or needs cleaning." });
    }

    // Cycling a room through dirty -> cleaning -> available is housekeeping's
    // routine work, done many times a day by a cleaner (or a receptionist
    // covering it). Marking a room out of order is a moderation decision and
    // stays exactly as it was. So only the cycle statuses need an override
    // from an owner or manager doing it themselves.
    const isCycleStatus = ["dirty", "cleaning", "available"].includes(status);
    const isOperationalRole = ["cleaner", "receptionist"].includes(req.user.role);
    if (isCycleStatus && !isOperationalRole && ["owner", "manager"].includes(req.user.role)) {
      if (req.body.override !== true) {
        return res.status(403).json({
          error: "This is normally done by housekeeping. Use the override option if you need to do it yourself right now.",
          requiresOverride: true,
        });
      }
      if (!req.body.overrideReason || !req.body.overrideReason.trim()) {
        return res.status(400).json({ error: "Give a short reason for the override." });
      }
      req.isOverride = true;
    }

    const before = room.status;
    room.status = status;
    if (note !== undefined) room.statusNote = note;
    if (status === "available") { room.lastCleanedAt = new Date(); room.lastCleanedBy = req.user.id; }
    await room.save();

    logAction(req, {
      action: (req.isOverride ? "OVERRIDE — " : "") +
        "Set room " + room.number + " to " + status +
        (req.isOverride ? " (" + req.body.overrideReason + ")" : ""),
      entity: "Room",
      entityId: room._id, location: room.location, before: { status: before }, after: { status },
    });
    res.json(room);
  } catch (e) { next(e); }
});

router.get("/availability", requireModule("bookings"), scopeLocation, async (req, res, next) => {
  try {
    const { checkIn, checkOut, roomType } = req.query;
    const bad = validRange(checkIn, checkOut);
    if (bad) return res.status(400).json({ error: bad });
    const free = await findAvailableRooms(req.location, checkIn, checkOut, { roomType });
    res.json({ location: req.location, checkIn, checkOut, count: free.length, rooms: free });
  } catch (e) { next(e); }
});

router.get("/rates", scopeLocation, async (req, res, next) => {
  try {
    const doc = await Rate.findOne({ location: req.location }).lean();
    res.json({
      location: req.location,
      prices: doc ? Object.fromEntries(Object.entries(doc.prices)) : LOCATIONS[req.location].rates,
      typeOrder: LOCATIONS[req.location].typeOrder,
    });
  } catch (e) { next(e); }
});

router.put("/rates", requireRole("manager", "owner"), scopeLocation, async (req, res, next) => {
  try {
    const { prices } = req.body;
    if (!prices || typeof prices !== "object") {
      return res.status(400).json({ error: "Send the new rates as a set of room type and amount pairs." });
    }
    for (const [type, amount] of Object.entries(prices)) {
      if (!LOCATIONS[req.location].typeOrder.includes(type)) {
        return res.status(400).json({ error: type + " is not a room type at this property." });
      }
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ error: "The rate for " + type + " must be a positive amount." });
      }
    }
    const before = await Rate.findOne({ location: req.location }).lean();
    const doc = await Rate.findOneAndUpdate(
      { location: req.location },
      { prices, updatedBy: req.user.id },
      { new: true, upsert: true }
    );
    logAction(req, {
      action: "Updated room rates", entity: "Rate", entityId: doc._id, location: req.location,
      before: before ? Object.fromEntries(Object.entries(before.prices)) : null, after: prices,
    });
    res.json({ location: req.location, prices: Object.fromEntries(Object.entries(doc.prices)) });
  } catch (e) { next(e); }
});

/* ---------------- discounts ---------------- */

/**
 * Offers against the published rates. They sit next to rates rather than
 * inside them because that is what they are to everyone who deals with them: a
 * separate thing a manager turns on and off, shown to guests in its own right,
 * that happens to come off the price at the moment of booking.
 */

const isDate = (v) => v === undefined || v === null || v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v);

function badDiscount(body, location) {
  if (!["percent", "fixed"].includes(body.kind)) {
    return "Say whether this is a percentage off or an amount off.";
  }
  const value = Number(body.value);
  if (!Number.isFinite(value) || value <= 0) return "The discount must be more than zero.";
  if (body.kind === "percent" && value > 90) {
    return "A percentage discount cannot be more than 90%.";
  }
  if (!String(body.name || "").trim()) return "Give the offer a name guests will read.";
  if (!isDate(body.startsOn) || !isDate(body.endsOn)) return "Dates must be given as YYYY-MM-DD.";
  if (body.startsOn && body.endsOn && body.endsOn < body.startsOn) {
    return "The offer cannot end before it starts.";
  }
  for (const t of body.roomTypes || []) {
    if (!LOCATIONS[location].typeOrder.includes(t)) {
      return t + " is not a room type at this property.";
    }
  }
  const min = Number(body.minNights ?? 1);
  if (!Number.isInteger(min) || min < 1) return "The minimum stay must be at least one night.";
  return null;
}

const fields = (body) => ({
  name: String(body.name).trim().slice(0, 80),
  blurb: String(body.blurb || "").trim().slice(0, 240) || undefined,
  kind: body.kind,
  value: Number(body.value),
  roomTypes: body.roomTypes || [],
  minNights: Number(body.minNights ?? 1),
  startsOn: body.startsOn || undefined,
  endsOn: body.endsOn || undefined,
  active: !!body.active,
});

router.get("/discounts", requireModule("rates"), scopeLocation, async (req, res, next) => {
  try {
    const rows = await Discount.find({ location: req.location }).sort({ active: -1, createdAt: -1 }).lean();
    res.json(rows.map((d) => ({ ...publicDiscount(d), active: d.active, updatedAt: d.updatedAt })));
  } catch (e) { next(e); }
});

router.post("/discounts", requireRole("manager", "owner"), scopeLocation, async (req, res, next) => {
  try {
    const bad = badDiscount(req.body || {}, req.location);
    if (bad) return res.status(400).json({ error: bad });
    const doc = await Discount.create({
      ...fields(req.body), location: req.location, createdBy: req.user.id,
    });
    logAction(req, {
      action: "Created the offer " + doc.name + " at " + LOCATIONS[req.location].name,
      entity: "Discount", entityId: doc._id, location: req.location, after: doc.toObject(),
    });
    res.status(201).json({ ...publicDiscount(doc), active: doc.active });
  } catch (e) { next(e); }
});

router.patch("/discounts/:id", requireRole("manager", "owner"), scopeLocation, async (req, res, next) => {
  try {
    const doc = await Discount.findOne({ _id: req.params.id, location: req.location });
    if (!doc) return res.status(404).json({ error: "That offer was not found." });

    // Turning one on or off is the everyday action and needs nothing else sent.
    const merged = { ...doc.toObject(), ...req.body };
    const bad = badDiscount(merged, req.location);
    if (bad) return res.status(400).json({ error: bad });

    const before = doc.toObject();
    Object.assign(doc, fields(merged), { updatedBy: req.user.id });
    await doc.save();
    logAction(req, {
      action: (before.active === doc.active ? "Edited the offer " : doc.active ? "Turned on the offer " : "Turned off the offer ") + doc.name,
      entity: "Discount", entityId: doc._id, location: req.location, before, after: doc.toObject(),
    });
    res.json({ ...publicDiscount(doc), active: doc.active });
  } catch (e) { next(e); }
});

router.delete("/discounts/:id", requireRole("manager", "owner"), scopeLocation, async (req, res, next) => {
  try {
    const doc = await Discount.findOneAndDelete({ _id: req.params.id, location: req.location });
    if (!doc) return res.status(404).json({ error: "That offer was not found." });
    logAction(req, {
      action: "Deleted the offer " + doc.name,
      entity: "Discount", entityId: doc._id, location: req.location, before: doc.toObject(),
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
