const router = require("express").Router();
const Payment = require("../models/Payment");
const Booking = require("../models/Booking");
const { requireAuth, requireModule, requireRole, scopeLocation } = require("../middleware/auth");
const { verifyTransaction, initializeTransaction } = require("../services/paystack");
const { logAction } = require("../services/audit");

router.use(requireAuth, requireModule("billing"));

/** Folios: every booking with what is charged, paid and owing. */
router.get("/folios", scopeLocation, async (req, res, next) => {
  try {
    const bookings = await Booking.find({ location: req.location, status: { $ne: "cancelled" } })
      .populate("guest", "name phone").sort({ checkIn: -1 }).limit(300).lean();

    const paid = await Payment.aggregate([
      { $match: { location: req.location, voided: false } },
      { $group: { _id: "$booking", total: { $sum: "$amount" } } },
    ]);
    const paidBy = Object.fromEntries(paid.map((p) => [String(p._id), p.total]));

    res.json(bookings.map((b) => ({
      bookingId: b._id, ref: b.ref, guest: b.guest?.name, phone: b.guest?.phone,
      roomNumber: b.roomNumber, roomType: b.roomType, status: b.status,
      checkIn: b.checkIn, checkOut: b.checkOut, nights: b.nights, rate: b.rate,
      charges: b.totalCharge,
      paid: paidBy[String(b._id)] || 0,
      balance: b.totalCharge - (paidBy[String(b._id)] || 0),
    })));
  } catch (e) { next(e); }
});

router.get("/booking/:bookingId", async (req, res, next) => {
  try {
    const payments = await Payment.find({ booking: req.params.bookingId, voided: false })
      .populate("recordedBy", "name").sort({ createdAt: -1 }).lean();
    res.json(payments);
  } catch (e) { next(e); }
});

/** Starts a Paystack transaction. The frontend gets only the reference and URL. */
router.post("/paystack/initialize", async (req, res, next) => {
  try {
    const { bookingId, amount, email } = req.body;
    const booking = await Booking.findById(bookingId).populate("guest", "name email");
    if (!booking) return res.status(404).json({ error: "That booking does not exist." });
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Enter an amount greater than zero." });
    }
    const reference = "DIVIC_" + booking.ref.replace("-", "") + "_" + Date.now().toString().slice(-6);
    const init = await initializeTransaction({
      email: email || booking.guest?.email || "frontdesk@divic.ng",
      amountNaira: amount,
      reference,
      metadata: { bookingRef: booking.ref, location: booking.location, roomNumber: booking.roomNumber },
      callbackUrl: process.env.CLIENT_ORIGIN + "/billing?ref=" + reference,
    });
    if (!init.status) return res.status(502).json({ error: "Paystack could not start this payment." });
    res.json({ reference, authorizationUrl: init.data.authorization_url, accessCode: init.data.access_code });
  } catch (e) { next(e); }
});

/**
 * Records a payment. For Paystack the reference is verified against Paystack
 * before anything lands on the folio — a client-side success callback is not
 * proof of payment.
 */
router.post("/", scopeLocation, async (req, res, next) => {
  try {
    const { bookingId, amount, method, paystackReference, note } = req.body;
    const booking = await Booking.findById(bookingId).populate("guest", "name");
    if (!booking) return res.status(404).json({ error: "That booking does not exist." });
    if (req.user.location !== "all" && booking.location !== req.user.location) {
      return res.status(403).json({ error: "You can only work on your own property." });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Enter an amount greater than zero." });
    }

    let verified = false, gatewayResponse;
    if (method === "paystack") {
      if (!paystackReference) return res.status(400).json({ error: "A Paystack payment needs its transaction reference." });
      const already = await Payment.findOne({ paystackReference, voided: false });
      if (already) return res.status(409).json({ error: "That Paystack reference has already been recorded." });

      const check = await verifyTransaction(paystackReference, Math.round(amount * 100));
      if (!check.ok) return res.status(402).json({ error: "Paystack did not confirm this payment. " + check.reason });
      verified = true;
      gatewayResponse = check.raw;
    }

    const payment = await Payment.create({
      booking: booking._id, location: booking.location,
      amount, method, paystackReference, verified,
      verifiedAt: verified ? new Date() : undefined,
      gatewayResponse, note, recordedBy: req.user.id,
    });

    logAction(req, {
      action: "Recorded " + amount + " naira by " + method + " on " + booking.ref,
      entity: "Payment", entityId: payment._id, location: booking.location,
    });
    req.app.get("io")?.to("loc:" + booking.location).emit("payment:recorded", { bookingId: booking._id, amount });
    res.status(201).json(payment);
  } catch (e) { next(e); }
});

/** Voiding a payment is a manager decision and leaves the original record in place. */
router.post("/:id/void", requireRole("manager", "owner"), async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: "That payment does not exist." });
    if (payment.voided) return res.status(409).json({ error: "That payment is already voided." });
    if (!req.body.reason) return res.status(400).json({ error: "Give a reason for voiding this payment." });

    payment.voided = true;
    payment.voidReason = req.body.reason;
    await payment.save();

    logAction(req, {
      action: "Voided a payment of " + payment.amount + " naira — " + req.body.reason,
      entity: "Payment", entityId: payment._id, location: payment.location,
    });
    res.json(payment);
  } catch (e) { next(e); }
});

module.exports = router;
