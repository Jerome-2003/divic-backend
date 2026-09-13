const Booking = require("../models/Booking");
const Charge = require("../models/Charge");
const Payment = require("../models/Payment");

/**
 * Turns money taken anywhere in a facility — a settled bar tab, a pool entry
 * fee, a gym subscription — into the Charge (and, when paid on the spot, the
 * Payment) that the rest of the PMS already understands.
 *
 * It exists so those three callers cannot drift apart. The rules about who may
 * charge a room, what counts as a valid payment method and which property a
 * booking has to belong to are the same rules in all three places, and a copy
 * of them that quietly diverges is how a guest ends up charged twice or not at
 * all. routes/facilities.routes.js keeps its own inline copy for the original
 * free-text till charge; everything added since comes through here.
 *
 * Returns { ok: false, status, error } rather than throwing, so a route can
 * hand the message straight back to the person at the till.
 */
async function settleFacilitySale({
  facility, settlement, bookingId, paymentMethod, amount, description, userId,
}) {
  if (!["room", "paid"].includes(settlement)) {
    return { ok: false, status: 400, error: "Choose whether this goes on the room or is being paid now." };
  }
  if (!Number.isFinite(amount) || amount < 1) {
    return { ok: false, status: 400, error: "Enter an amount of at least 1 naira." };
  }

  let booking = null;
  let payment = null;

  if (settlement === "room") {
    if (!bookingId) {
      return { ok: false, status: 400, error: "Look up the guest's room before charging it to their room." };
    }
    booking = await Booking.findById(bookingId);
    if (!booking) return { ok: false, status: 404, error: "That booking does not exist." };
    if (booking.location !== facility.location) {
      return { ok: false, status: 403, error: "That booking belongs to the other property." };
    }
    if (booking.status !== "in-house") {
      return { ok: false, status: 409, error: "That guest is not checked in, so nothing can be charged to their room." };
    }
  } else {
    // Cash, card or transfer. A Paystack charge needs a verified reference and
    // belongs at the front desk, not on a facility till.
    const asked = String(paymentMethod || "").trim().toLowerCase();
    const method = asked === "card" ? "pos" : asked;
    if (!["cash", "pos", "transfer"].includes(method)) {
      return { ok: false, status: 400, error: "Take payment by cash, card or transfer." };
    }
    payment = await Payment.create({
      location: facility.location,
      facility: facility._id,
      amount, method,
      note: facility.name + " — " + description,
      recordedBy: userId,
    });
  }

  const charge = await Charge.create({
    booking: booking ? booking._id : undefined,
    location: facility.location,
    facility: facility._id,
    description, amount, settlement,
    payment: payment ? payment._id : undefined,
    postedBy: userId,
  });

  return { ok: true, booking, payment, charge };
}

/** Refuses a sale at a facility that is shut. Same wording staff already see. */
function facilityClosedError(facility) {
  if (facility.status === "open") return null;
  const how = facility.status === "maintenance" ? "under maintenance" : "closed";
  return {
    status: 409,
    error: facility.name + " is " + how + " and cannot take a sale." +
      (facility.statusNote ? " " + facility.statusNote : ""),
  };
}

module.exports = { settleFacilitySale, facilityClosedError };
