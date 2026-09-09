const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Room = require("../models/Room");
const Guest = require("../models/Guest");
const Payment = require("../models/Payment");
const { pickRoom } = require("./roomAssignment");
const { splitSettlement } = require("./paystackFees");
const { notify } = require("./notify");
const { LOCATIONS } = require("../utils/constants");

/**
 * Turns a paid website request into a real booking.
 *
 * The rule this encodes is worth stating plainly, because it is the one place
 * the system deliberately departs from "the website never touches inventory":
 *
 *   An UNPAID request holds no room. That is what stops a stranger on the
 *   internet taking a room out from under a walk-in standing at the desk, and
 *   it is unchanged — those still wait for a receptionist to accept them.
 *
 *   A PAID request must hold a room immediately. Once money has moved the guest
 *   has a contract, and holding their payment with no room reserved is worse
 *   than the double-booking risk it was protecting against.
 *
 * If every room of the requested type went during checkout, the booking is
 * still created — flagged needsAttention with no room — and staff are alerted
 * urgently. Taking money and quietly dropping the booking is the one outcome
 * that must never happen.
 *
 * Idempotent: Paystack can deliver a webhook more than once, and the website
 * polls the status endpoint as well, so this may be called repeatedly for the
 * same reference.
 */
async function settlePaidRequest(app, requestDoc, verification) {
  if (requestDoc.payment.verified && requestDoc.booking) {
    return Booking.findById(requestDoc.booking);
  }

  const amountPaid = verification.amountNaira;
  const split = splitSettlement(amountPaid, requestDoc.quotedTotal);

  let booking;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Guard again inside the transaction: two webhook deliveries arriving
      // together would otherwise both pass the check above.
      const fresh = await require("../models/BookingRequest")
        .findById(requestDoc._id).session(session);
      if (fresh.payment.verified && fresh.booking) {
        booking = await Booking.findById(fresh.booking).session(session);
        return;
      }

      let guest = await Guest.findOne({ phone: requestDoc.guestPhone }).session(session);
      if (!guest) {
        guest = (await Guest.create([{
          name: requestDoc.guestName,
          phone: requestDoc.guestPhone,
          email: requestDoc.guestEmail,
        }], { session }))[0];
      }

      const room = await pickRoom(
        requestDoc.location, requestDoc.checkIn, requestDoc.checkOut, requestDoc.roomType,
        { nights: requestDoc.nights }
      );

      const prefix = requestDoc.location === "exclusive" ? "DX-" : "DU-";
      booking = (await Booking.create([{
        ref: prefix + Math.floor(1000 + Math.random() * 9000),
        location: requestDoc.location,
        guest: guest._id,
        room: room ? room._id : undefined,
        roomNumber: room ? room.number : undefined,
        roomType: requestDoc.roomType,
        checkIn: requestDoc.checkIn,
        checkOut: requestDoc.checkOut,
        nights: requestDoc.nights,
        rate: requestDoc.quotedRate,
        totalCharge: requestDoc.quotedTotal,
        adults: requestDoc.adults,
        children: requestDoc.children,
        status: "confirmed",
        source: "website",
        specialRequests: requestDoc.specialRequests,
        fromRequest: requestDoc._id,
        autoAssigned: !!room,
        needsAttention: !room,
        attentionReason: room
          ? undefined
          : "Paid online, but every " + requestDoc.roomType + " room was taken during checkout. Place this guest by hand or call them to offer another room type.",
      }], { session }))[0];

      // The hotel's revenue is the net. The processing fee is recorded but must
      // never be counted as room revenue in analytics.
      await Payment.create([{
        booking: booking._id,
        location: requestDoc.location,
        amount: split.amountPaid,
        feeAmount: split.feeAmount,
        netAmount: split.netAmount,
        method: "paystack",
        paystackReference: requestDoc.payment.paystackReference,
        verified: true,
        verifiedAt: new Date(),
        gatewayResponse: verification.raw,
        note: "Paid on the website at time of booking",
      }], { session });

      fresh.payment.verified = true;
      fresh.payment.verifiedAt = new Date();
      fresh.payment.amount = split.amountPaid;
      fresh.status = "accepted";
      fresh.booking = booking._id;
      fresh.handledAt = new Date();
      await fresh.save({ session });

      requestDoc.payment.verified = true;
      requestDoc.status = "accepted";
      requestDoc.booking = booking._id;
    });
  } finally {
    session.endSession();
  }

  if (booking && booking.needsAttention) {
    await notify(app, {
      location: requestDoc.location,
      type: "booking:unassigned",
      title: "Paid booking with no room — " + requestDoc.guestName,
      body: requestDoc.nights + " night" + (requestDoc.nights === 1 ? "" : "s") + " from " + requestDoc.checkIn +
            ". Payment went through but no " + requestDoc.roomType + " room is free. Call the guest on " +
            requestDoc.guestPhone + ".",
      entity: "Booking", entityId: booking._id, href: "/bookings",
      urgent: true,
    });
  } else if (booking) {
    await notify(app, {
      location: requestDoc.location,
      type: "booking:auto",
      title: "Website booking paid — room " + booking.roomNumber,
      body: requestDoc.guestName + ", " + requestDoc.nights + " night" + (requestDoc.nights === 1 ? "" : "s") +
            " from " + requestDoc.checkIn + ". Room chosen automatically; change it if you need to.",
      entity: "Booking", entityId: booking._id, href: "/bookings",
    });
  }

  try {
    const io = app?.get("io");
    io?.to("loc:" + requestDoc.location).emit("booking:created", booking);
    io?.to("loc:" + requestDoc.location).emit("payment:recorded", {
      bookingId: booking?._id,
      reference: requestDoc.reference,
      paystackReference: requestDoc.payment?.paystackReference,
      amount: requestDoc.payment?.amount ?? verification.amountNaira,
      method: "paystack",
      verified: true,
    });
  } catch { /* the booking is saved; a missed socket frame is not worth failing over */ }

  return booking;
}

module.exports = { settlePaidRequest };
