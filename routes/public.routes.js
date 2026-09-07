const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const BookingRequest = require("../models/BookingRequest");
const Rate = require("../models/Rate");
const Facility = require("../models/Facility");
const { availabilityByType, validRange, nightsBetween } = require("../services/availability");
const { LOCATIONS, ROOM_PLAN } = require("../utils/constants");
const { verifyTransaction } = require("../services/paystack");

/**
 * PUBLIC ENDPOINTS — no authentication.
 *
 * This is what the hotel's marketing website talks to. It can read rates and
 * availability and lodge a booking request. It can NOT create a booking, touch
 * a room, or see a guest record. Everything a stranger sends is treated as
 * untrusted input.
 */

const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: "Too many booking requests from this connection. Please call the hotel instead." },
});

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const clean = (s, max = 200) => String(s || "").trim().slice(0, max);
const today = () => new Date().toISOString().slice(0, 10);

/** GET /api/public/properties — everything the website needs to render itself. */
router.get("/properties", async (_req, res, next) => {
  try {
    const rateDocs = await Rate.find().lean();
    const rateBy = Object.fromEntries(rateDocs.map((d) => [d.location, Object.fromEntries(Object.entries(d.prices))]));

    // Only open facilities are published. The public site has no business
    // telling a prospective guest the gym is under maintenance, and the status
    // note is an internal message ("Pump being serviced") that never ships.
    const facilities = await Facility.find({ status: "open" })
      .select("location name slug type openingHours").sort({ type: 1, name: 1 }).lean();
    const facilitiesBy = facilities.reduce((a, f) => {
      (a[f.location] = a[f.location] || []).push({
        name: f.name, slug: f.slug, type: f.type, openingHours: f.openingHours || null,
      });
      return a;
    }, {});

    res.json(Object.values(LOCATIONS).map((l) => {
      const plan = ROOM_PLAN[l.id];
      const types = l.typeOrder.map((type) => ({
        type,
        rate: (rateBy[l.id] || l.rates)[type],
        roomCount: plan.filter((r) => r.type === type).length,
        floors: [...new Set(plan.filter((r) => r.type === type).map((r) => r.floor))].sort(),
      }));
      return {
        id: l.id, name: l.name, address: l.address, phone: l.phone,
        totalRooms: plan.length, currency: "NGN", roomTypes: types,
        facilities: facilitiesBy[l.id] || [],
      };
    }));
  } catch (e) { next(e); }
});

/** GET /api/public/availability?location=urban&checkIn=&checkOut= */
router.get("/availability", async (req, res, next) => {
  try {
    const { location, checkIn, checkOut } = req.query;
    if (!LOCATIONS[location]) return res.status(400).json({ error: "Choose a property." });
    const bad = validRange(checkIn, checkOut);
    if (bad) return res.status(400).json({ error: bad });
    if (checkIn < today()) return res.status(400).json({ error: "Check-in cannot be in the past." });

    const counts = await availabilityByType(location, checkIn, checkOut);
    const rateDoc = await Rate.findOne({ location }).lean();
    const prices = rateDoc ? Object.fromEntries(Object.entries(rateDoc.prices)) : LOCATIONS[location].rates;
    const n = nightsBetween(checkIn, checkOut);

    res.json({
      location, checkIn, checkOut, nights: n, currency: "NGN",
      // Availability is exposed as counts only. Never publish room numbers to
      // the public web — that tells a stranger exactly which rooms are empty.
      roomTypes: LOCATIONS[location].typeOrder.map((type) => ({
        type, available: counts[type] || 0,
        rate: prices[type], total: prices[type] * n,
      })),
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/public/booking-requests
 *
 * Body:
 * {
 *   "location":        "exclusive" | "urban",
 *   "roomType":        "standard" | "deluxe" | "superior" | "classic" | "crown",
 *   "checkIn":         "2026-09-20",
 *   "checkOut":        "2026-09-23",
 *   "adults":          2,
 *   "children":        0,
 *   "guestName":       "Adaeze Okonkwo",
 *   "guestPhone":      "08031234567",
 *   "guestEmail":      "adaeze@example.com",
 *   "specialRequests": "High floor if possible",
 *   "paystackReference": "T123456789"        // optional, only if you take a deposit online
 * }
 *
 * Returns 201 with { reference, status: "pending", quotedRate, quotedTotal }.
 * The guest is told the hotel will confirm — no room is held yet.
 */
router.post("/booking-requests", requestLimiter, async (req, res, next) => {
  try {
    const b = req.body || {};
    const location = b.location;
    if (!LOCATIONS[location]) return res.status(400).json({ error: "Choose a property." });
    if (!LOCATIONS[location].typeOrder.includes(b.roomType)) {
      return res.status(400).json({ error: "That room type is not available at this property." });
    }
    const bad = validRange(b.checkIn, b.checkOut);
    if (bad) return res.status(400).json({ error: bad });
    if (b.checkIn < today()) return res.status(400).json({ error: "Check-in cannot be in the past." });

    const name = clean(b.guestName, 120);
    const phone = clean(b.guestPhone, 20);
    if (name.length < 2) return res.status(400).json({ error: "Enter the guest's full name." });
    if (!/^[0-9+\-\s()]{7,20}$/.test(phone)) return res.status(400).json({ error: "Enter a valid phone number." });

    const adults = Math.min(Math.max(Number(b.adults) || 1, 1), 6);
    const children = Math.min(Math.max(Number(b.children) || 0, 0), 6);

    // Price is recalculated server-side. Never trust a total sent by the browser.
    const rateDoc = await Rate.findOne({ location }).lean();
    const prices = rateDoc ? Object.fromEntries(Object.entries(rateDoc.prices)) : LOCATIONS[location].rates;
    const rate = prices[b.roomType];
    const nights = nightsBetween(b.checkIn, b.checkOut);

    const counts = await availabilityByType(location, b.checkIn, b.checkOut);
    const likelyAvailable = (counts[b.roomType] || 0) > 0;

    const payment = { required: false, verified: false };
    if (b.paystackReference) {
      const check = await verifyTransaction(clean(b.paystackReference, 100), rate * nights * 100);
      payment.paystackReference = clean(b.paystackReference, 100);
      payment.required = true;
      payment.verified = check.ok;
      payment.amount = check.ok ? check.amountNaira : undefined;
      payment.verifiedAt = check.ok ? new Date() : undefined;
      if (!check.ok) return res.status(402).json({ error: "We could not confirm that payment. " + check.reason });
    }

    const doc = await BookingRequest.create({
      reference: "WEB-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      location, roomType: b.roomType,
      checkIn: b.checkIn, checkOut: b.checkOut, nights,
      adults, children,
      guestName: name, guestPhone: phone,
      guestEmail: clean(b.guestEmail, 120).toLowerCase() || undefined,
      specialRequests: clean(b.specialRequests, 500) || undefined,
      quotedRate: rate, quotedTotal: rate * nights,
      payment,
      sourceIp: req.headers["x-forwarded-for"] || req.ip,
      userAgent: clean(req.headers["user-agent"], 200),
    });

    req.app.get("io")?.to("loc:" + location).emit("request:new", {
      reference: doc.reference, guestName: doc.guestName, roomType: doc.roomType,
      checkIn: doc.checkIn, checkOut: doc.checkOut,
    });

    res.status(201).json({
      reference: doc.reference,
      status: "pending",
      location: LOCATIONS[location].name,
      roomType: doc.roomType,
      checkIn: doc.checkIn, checkOut: doc.checkOut, nights,
      quotedRate: rate, quotedTotal: rate * nights, currency: "NGN",
      likelyAvailable,
      message: likelyAvailable
        ? "Your request has been received. The hotel will call you to confirm and hold your room."
        : "Your request has been received, but this room type looks fully booked for those dates. The hotel will call you with alternatives.",
      hotelPhone: LOCATIONS[location].phone,
    });
  } catch (e) { next(e); }
});

/** GET /api/public/booking-requests/:reference — lets a guest check their own request. */
router.get("/booking-requests/:reference", async (req, res, next) => {
  try {
    const doc = await BookingRequest.findOne({ reference: req.params.reference.toUpperCase() })
      .select("reference status location roomType checkIn checkOut nights quotedTotal createdAt").lean();
    if (!doc) return res.status(404).json({ error: "No request found with that reference." });
    res.json({ ...doc, locationName: LOCATIONS[doc.location].name });
  } catch (e) { next(e); }
});

module.exports = router;
