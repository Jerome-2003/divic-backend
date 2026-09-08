const router = require("express").Router();
const Facility = require("../models/Facility");
const Charge = require("../models/Charge");
const Payment = require("../models/Payment");
const Booking = require("../models/Booking");
const {
  requireAuth, requireModule, requireRole, requireOperational, scopeLocation, requireAssignedFacility,
} = require("../middleware/auth");
const { logAction } = require("../services/audit");
const { FACILITY_STATUSES, CHARGE_SETTLEMENTS } = require("../utils/constants");

router.use(requireAuth);

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const clean = (s, max = 200) => String(s || "").trim().slice(0, max);

// A surname is the last word of the stored full name. That is all a bartender
// needs to confirm they have the right guest.
const surnameOf = (name) => String(name || "").trim().split(/\s+/).pop() || "";

const publicFacility = (f, user) => ({
  id: f._id, location: f.location, name: f.name, slug: f.slug, type: f.type,
  sellsItems: f.sellsItems, status: f.status, statusNote: f.statusNote || null,
  openingHours: f.openingHours || null,
  // Convenience for the frontend so a bartender is only offered their own
  // tills. Not a security boundary — that is requireAssignedFacility.
  assignedToMe: user.role === "facility"
    ? user.assignedFacilities.includes(String(f._id))
    : ["manager", "owner"].includes(user.role),
});

/**
 * GET /api/facilities?location=
 * Every signed-in user, housekeeping included — a cleaner should be able to
 * see that the pool is closed.
 */
router.get("/", scopeLocation, async (req, res, next) => {
  try {
    const facilities = await Facility.find({ location: req.location })
      .sort({ type: 1, name: 1 }).lean();
    res.json(facilities.map((f) => publicFacility(f, req.user)));
  } catch (e) { next(e); }
});

/**
 * PATCH /api/facilities/:id  { status, note }
 * Managers and owners, plus facility staff for the facilities they cover.
 * Nothing else about a facility is editable here — the name, type and whether
 * it sells anything come from the seed.
 */
router.patch("/:id", requireModule("facilities"), requireAssignedFacility("id"), async (req, res, next) => {
  try {
    const { status, note } = req.body;
    if (!FACILITY_STATUSES.includes(status)) {
      return res.status(400).json({ error: "A facility can be open, closed or under maintenance." });
    }
    const facility = req.facility;
    const before = { status: facility.status, statusNote: facility.statusNote };
    facility.status = status;
    if (note !== undefined) facility.statusNote = clean(note, 300);
    facility.updatedBy = req.user.id;
    await facility.save();

    logAction(req, {
      action: "Set " + facility.name + " to " + status + (facility.statusNote ? " — " + facility.statusNote : ""),
      entity: "Facility", entityId: facility._id, location: facility.location,
      before, after: { status: facility.status, statusNote: facility.statusNote },
    });
    req.app.get("io")?.to("loc:" + facility.location).emit("facility:updated", publicFacility(facility, req.user));
    res.json(publicFacility(facility, req.user));
  } catch (e) { next(e); }
});

/**
 * GET /api/facilities/:facilityId/guest-lookup?room=204
 *
 * Confirms a guest is in that room and nothing more: room number, surname and
 * the booking id needed to post a charge. No first name, no phone, no email,
 * no ID number, no folio balance, no stay dates. A bartender confirming a
 * guest exists is legitimate; a bartender browsing guest records is not, and
 * there is deliberately no endpoint here that lists in-house guests.
 */
router.get("/:facilityId/guest-lookup", requireModule("pos"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const room = clean(req.query.room, 10);
    if (!room) return res.status(400).json({ error: "Enter the room number." });

    const booking = await Booking.findOne({
      location: req.facility.location, roomNumber: room, status: "in-house",
    }).populate("guest", "name").lean();

    if (!booking) return res.status(404).json({ error: "Nobody is checked in to room " + room + "." });

    res.json({
      roomNumber: booking.roomNumber,
      surname: surnameOf(booking.guest?.name),
      bookingId: String(booking._id),
    });
  } catch (e) { next(e); }
});

const chargeJSON = (c, facility) => ({
  id: c._id,
  facility: { id: facility._id, name: facility.name, type: facility.type },
  location: c.location,
  description: c.description,
  amount: c.amount,
  settlement: c.settlement,
  bookingId: c.booking ? String(c.booking) : null,
  paymentId: c.payment ? String(c.payment) : null,
  postedBy: c.postedBy ? String(c.postedBy) : null,
  voided: c.voided,
  voidReason: c.voidReason || null,
  createdAt: c.createdAt,
});

/**
 * POST /api/facilities/:facilityId/charges
 * { description, amount, settlement, bookingId?, paymentMethod? }
 *
 * At the till the guest either charges it to their room or pays on the spot.
 * Both are supported; everything about which is allowed is decided here, never
 * by the client.
 */
router.post("/:facilityId/charges", requireModule("pos"), requireAssignedFacility(), requireOperational("facility"), async (req, res, next) => {
  try {
    const facility = req.facility;
    if (!facility.sellsItems) {
      return res.status(400).json({ error: facility.name + " does not sell anything, so it cannot post a charge." });
    }
    if (facility.status !== "open") {
      const how = facility.status === "maintenance" ? "under maintenance" : "closed";
      return res.status(409).json({
        error: facility.name + " is " + how + " and cannot take a sale." +
          (facility.statusNote ? " " + facility.statusNote : ""),
      });
    }

    const description = clean(req.body.description, 200);
    const amount = Number(req.body.amount);
    const { settlement, bookingId } = req.body;

    if (description.length < 2) return res.status(400).json({ error: "Say what was sold." });
    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({ error: "Enter an amount of at least 1 naira." });
    }
    if (!CHARGE_SETTLEMENTS.includes(settlement)) {
      return res.status(400).json({ error: "Choose whether this goes on the room or is being paid now." });
    }

    let booking = null;
    let payment = null;

    if (settlement === "room") {
      if (!bookingId) {
        return res.status(400).json({ error: "Look up the guest's room before charging it to their room." });
      }
      booking = await Booking.findById(bookingId);
      if (!booking) return res.status(404).json({ error: "That booking does not exist." });
      if (booking.location !== facility.location) {
        return res.status(403).json({ error: "That booking belongs to the other property." });
      }
      if (booking.status !== "in-house") {
        return res.status(409).json({ error: "That guest is not checked in, so nothing can be charged to their room." });
      }
    } else {
      // Paying now. Cash, card or transfer — a Paystack charge needs a verified
      // reference and belongs at the front desk, not on a facility till.
      const asked = clean(req.body.paymentMethod, 20).toLowerCase();
      const method = asked === "card" ? "pos" : asked;
      if (!["cash", "pos", "transfer"].includes(method)) {
        return res.status(400).json({ error: "Take payment by cash, card or transfer." });
      }
      payment = await Payment.create({
        location: facility.location,
        facility: facility._id,
        amount, method,
        note: facility.name + " — " + description,
        recordedBy: req.user.id,
      });
    }

    const charge = await Charge.create({
      booking: booking ? booking._id : undefined,
      location: facility.location,
      facility: facility._id,
      description, amount, settlement,
      payment: payment ? payment._id : undefined,
      postedBy: req.user.id,
    });

    logAction(req, {
      action: (req.isOverride ? "OVERRIDE — " : "") +
        "Posted " + amount + " naira at " + facility.name + " — " + description +
        (booking ? " to room " + booking.roomNumber : " paid at the till") +
        (req.isOverride ? " (" + req.body.overrideReason + ")" : ""),
      entity: "Charge", entityId: charge._id, location: facility.location,
      after: charge.toObject(),
    });
    req.app.get("io")?.to("loc:" + facility.location).emit("charge:posted", {
      facility: facility.name, amount, settlement,
      bookingId: booking ? String(booking._id) : null,
    });

    res.status(201).json(chargeJSON(charge, facility));
  } catch (e) { next(e); }
});

/**
 * GET /api/facilities/:facilityId/charges?date=YYYY-MM-DD
 * That facility's own charges for one shift. Facility staff reach only the
 * facilities they are assigned to — requireAssignedFacility sees to that.
 */
router.get("/:facilityId/charges", requireModule("pos"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const date = req.query.date ? clean(req.query.date, 10) : today();
    if (!isDate(date)) return res.status(400).json({ error: "Send the date as YYYY-MM-DD." });
    const from = new Date(date + "T00:00:00.000Z");
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);

    const charges = await Charge.find({
      facility: req.facility._id, createdAt: { $gte: from, $lt: to },
    }).populate("postedBy", "name").sort({ createdAt: -1 }).lean();

    const live = charges.filter((c) => !c.voided);
    res.json({
      facility: { id: req.facility._id, name: req.facility.name, type: req.facility.type },
      date,
      totals: {
        chargedToRooms: live.filter((c) => c.settlement === "room").reduce((s, c) => s + c.amount, 0),
        paidAtTill: live.filter((c) => c.settlement === "paid").reduce((s, c) => s + c.amount, 0),
        total: live.reduce((s, c) => s + c.amount, 0),
        count: live.length,
      },
      charges: charges.map((c) => ({
        ...chargeJSON(c, req.facility),
        postedByName: c.postedBy?.name || null,
      })),
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/facilities/:facilityId/charges/:chargeId/void  { reason }
 *
 * Managers and owners only, and it needs a reason. This is deliberate: the
 * person who takes the money must not be the person who can make it disappear.
 * The charge is voided, never deleted, and a till payment behind it is voided
 * with it so the two cannot fall out of step.
 */
router.post(
  "/:facilityId/charges/:chargeId/void",
  requireRole("manager", "owner"), requireAssignedFacility(),
  async (req, res, next) => {
    try {
      const reason = clean(req.body.reason, 300);
      if (!reason) return res.status(400).json({ error: "Give a reason for voiding this charge." });

      const charge = await Charge.findOne({ _id: req.params.chargeId, facility: req.facility._id });
      if (!charge) return res.status(404).json({ error: "That charge does not exist at this facility." });
      if (charge.voided) return res.status(409).json({ error: "That charge is already voided." });

      charge.voided = true;
      charge.voidReason = reason;
      await charge.save();

      if (charge.payment) {
        await Payment.updateOne(
          { _id: charge.payment, voided: false },
          { $set: { voided: true, voidReason: reason } }
        );
      }

      logAction(req, {
        action: "Voided a " + charge.amount + " naira charge at " + req.facility.name + " — " + reason,
        entity: "Charge", entityId: charge._id, location: charge.location,
        before: { voided: false }, after: { voided: true, voidReason: reason },
      });
      req.app.get("io")?.to("loc:" + charge.location).emit("charge:voided", { chargeId: String(charge._id) });
      res.json(chargeJSON(charge, req.facility));
    } catch (e) { next(e); }
  }
);

module.exports = router;
