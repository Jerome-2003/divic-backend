/**
 * Folio arithmetic, in one place.
 *
 * A guest now owes money from two sources: the room itself (Booking.totalCharge)
 * and anything charged to the room at a facility (Charge with settlement "room").
 * Every screen that shows a balance has to add both, so the sum lives here
 * rather than being repeated — and drifting — in five route files.
 *
 * A charge settled at the till ("paid") is already square with the hotel and
 * never touches a folio. A payment with no booking is a walk-in's till payment
 * and must never be credited against someone's room.
 */

const Payment = require("../models/Payment");
const Charge = require("../models/Charge");

const idsOf = (bookings) => bookings.map((b) => b._id || b.id).filter(Boolean);

/** Facility charges owed against each of these bookings, keyed by booking id. */
async function facilityChargeTotals(bookingIds) {
  if (!bookingIds.length) return {};
  const rows = await Charge.aggregate([
    { $match: { booking: { $in: bookingIds }, voided: false, settlement: "room" } },
    { $group: { _id: "$booking", total: { $sum: "$amount" } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.total]));
}

/** Payments credited to each of these bookings, keyed by booking id. */
async function paymentTotals(bookingIds) {
  if (!bookingIds.length) return {};
  const rows = await Payment.aggregate([
    { $match: { booking: { $in: bookingIds }, voided: false } },
    { $group: { _id: "$booking", total: { $sum: "$amount" } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.total]));
}

const settle = (roomCharges, facilityCharges, paid) => ({
  roomCharges,
  facilityCharges,
  totalCharges: roomCharges + facilityCharges,
  paid,
  balance: roomCharges + facilityCharges - paid,
});

/**
 * Folios for a list of bookings (lean docs or documents), as a plain object
 * keyed by booking id. Two aggregations for the whole list, not two per row.
 */
async function foliosFor(bookings) {
  const ids = idsOf(bookings);
  const [facilityBy, paidBy] = await Promise.all([facilityChargeTotals(ids), paymentTotals(ids)]);
  const out = {};
  for (const b of bookings) {
    const key = String(b._id || b.id);
    out[key] = settle(b.totalCharge || 0, facilityBy[key] || 0, paidBy[key] || 0);
  }
  return out;
}

/** The same thing for a single booking. */
async function folioFor(booking) {
  const all = await foliosFor([booking]);
  return all[String(booking._id || booking.id)];
}

/** The facility charge lines behind a folio, for an itemised bill. */
async function facilityChargeLines(bookingId) {
  return Charge.find({ booking: bookingId, voided: false, settlement: "room" })
    .populate("facility", "name type")
    .sort({ createdAt: 1 })
    .lean();
}

module.exports = { foliosFor, folioFor, facilityChargeTotals, paymentTotals, facilityChargeLines };
