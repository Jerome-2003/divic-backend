/**
 * Folio arithmetic, in one place.
 *
 * A guest now owes money from two sources: the room itself (Booking.totalCharge)
 * and anything charged to the room at a facility (Charge with settlement "room").
 * Every screen that shows a balance has to add both, so the sum lives here
 * rather than being repeated — and drifting — in five route files.
 *
 * A charge settled at the till ("paid") is already square with the hotel and
 * never touches a folio — that is the whole distinction. A guest who pays for
 * their drinks at the bar has no bill at the front desk; only a guest who
 * chose to sign it to their room does, and then it is itemised by which
 * facility it came from. A payment with no booking is a walk-in's till payment
 * and must never be credited against someone's room.
 */

const Payment = require("../models/Payment");
const Charge = require("../models/Charge");
const Facility = require("../models/Facility");

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

/**
 * The same money, split by where it was spent, keyed by booking id.
 *
 * One lump is not enough any more. When the bar was the only facility, "bar"
 * was an accurate label for everything a guest had signed for; now that the
 * pool and the gym can be signed to a room too, a single figure under one
 * facility's name is simply wrong on the bill — and "what is this ₦18,000
 * for?" is the question a bill exists to answer.
 */
async function facilityChargeBreakdown(bookingIds) {
  if (!bookingIds.length) return {};
  const rows = await Charge.aggregate([
    { $match: { booking: { $in: bookingIds }, voided: false, settlement: "room" } },
    { $group: {
        _id: { booking: "$booking", facility: "$facility" },
        amount: { $sum: "$amount" }, items: { $sum: 1 },
    } },
  ]);

  const facilities = await Facility.find({ _id: { $in: rows.map((r) => r._id.facility) } })
    .select("name type").lean();

  return shapeBreakdown(rows, facilities);
}

/**
 * The naming and grouping half of the breakdown, without the database.
 *
 * Separated so it can be tested: whether a deleted facility silently drops a
 * charge off a bill the guest still owes is not something to find out from a
 * guest at the counter.
 */
function shapeBreakdown(rows, facilities) {
  const byId = Object.fromEntries(facilities.map((f) => [String(f._id), f]));
  const out = {};
  rows.forEach((r) => {
    const key = String(r._id.booking);
    const f = byId[String(r._id.facility)];
    (out[key] = out[key] || []).push({
      facilityId: r._id.facility,
      // A facility that has since been deleted must not make its charges
      // vanish from a bill. The money is still owed; it is named plainly.
      name: f?.name || "A facility",
      type: f?.type || null,
      amount: r.amount,
      items: r.items,
    });
  });
  // Largest first, so the line a guest is asking about is the one at the top.
  Object.values(out).forEach((list) => list.sort((a, b) => b.amount - a.amount));
  return out;
}

/**
 * Payments credited to each of these bookings, keyed by booking id.
 *
 * Credits the NET, not the amount charged. When a guest pays online the card
 * fee is added on top of the room rate, so `amount` is larger than what the
 * booking actually owes. Summing `amount` would show every website booking as
 * overpaid and hand out phantom credit at the desk. `netAmount` is what reached
 * the hotel; it falls back to `amount` for the older records and for cash,
 * transfer and POS payments, where no fee was ever added.
 */
async function paymentTotals(bookingIds) {
  if (!bookingIds.length) return {};
  const rows = await Payment.aggregate([
    { $match: { booking: { $in: bookingIds }, voided: false } },
    { $group: {
        _id: "$booking",
        total: { $sum: { $ifNull: ["$netAmount", "$amount"] } },
    } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.total]));
}

const settle = (roomCharges, facilityCharges, paid, byFacility) => ({
  roomCharges,
  facilityCharges,
  // Named, so a bill can say "Rooftop Bar" and "Pool" rather than putting the
  // pool's money under the bar's name.
  facilityBreakdown: byFacility || [],
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
  const [facilityBy, paidBy, breakdownBy] = await Promise.all([
    facilityChargeTotals(ids), paymentTotals(ids), facilityChargeBreakdown(ids),
  ]);
  const out = {};
  for (const b of bookings) {
    const key = String(b._id || b.id);
    out[key] = settle(b.totalCharge || 0, facilityBy[key] || 0, paidBy[key] || 0, breakdownBy[key]);
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

module.exports = {
  foliosFor, folioFor, facilityChargeTotals, facilityChargeBreakdown,
  shapeBreakdown, paymentTotals, facilityChargeLines,
};
