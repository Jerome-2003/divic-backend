/**
 * Email notifications for the three events staff asked for: a booking being
 * confirmed, a payment being recorded, and a website booking request coming
 * in. Every one of them sends a copy to the guest (when an email is on file)
 * and a copy to the hotel. Nothing here is awaited by its caller — a slow or
 * failing mail server must never hold up a booking or a payment.
 */

const { sendMail } = require("./mailer");
const { LOCATIONS } = require("../utils/constants");

const HOTEL_EMAIL = process.env.HOTEL_EMAIL || "info@divicexclusivehotels.com.ng";
const money = (n) => "₦" + Number(n || 0).toLocaleString("en-NG");

function footer(location) {
  const loc = LOCATIONS[location];
  return [loc.name, loc.address, loc.phone].join("\n");
}

/** A booking has been confirmed — either made directly or accepted from a website request. */
function notifyBookingConfirmed(booking, guest) {
  const loc = LOCATIONS[booking.location];
  const lines = [
    "Reference: " + booking.ref,
    "Guest: " + (guest?.name || "—"),
    "Room: " + booking.roomNumber + " (" + booking.roomType + ")",
    "Check-in: " + booking.checkIn,
    "Check-out: " + booking.checkOut,
    "Nights: " + booking.nights,
    "Rate: " + money(booking.rate) + " per night",
    "Total: " + money(booking.totalCharge),
  ];

  if (guest?.email) {
    sendMail({
      to: guest.email,
      subject: "Booking confirmed — " + booking.ref,
      text: [
        "Hello " + guest.name + ",",
        "",
        "Your booking at " + loc.name + " is confirmed.",
        "",
        ...lines,
        "",
        "We look forward to having you.",
        "",
        footer(booking.location),
      ].join("\n"),
    });
  }

  sendMail({
    to: HOTEL_EMAIL,
    subject: "Booking confirmed — " + booking.ref + " (" + loc.name + ")",
    text: [
      "A booking was confirmed at " + loc.name + ".",
      "",
      ...lines,
      "Guest phone: " + (guest?.phone || "—"),
      "Source: " + (booking.source || "—"),
    ].join("\n"),
  });
}

/** A payment has been recorded against a booking. */
function notifyPaymentRecorded(payment, booking, guest) {
  const loc = LOCATIONS[booking.location];
  const lines = [
    "Booking reference: " + booking.ref,
    "Room: " + booking.roomNumber,
    "Amount: " + money(payment.amount),
    "Method: " + payment.method,
  ];

  if (guest?.email) {
    sendMail({
      to: guest.email,
      subject: "Payment received — " + booking.ref,
      text: [
        "Hello " + guest.name + ",",
        "",
        "This confirms we received your payment.",
        "",
        ...lines,
        "",
        "Thank you.",
        "",
        footer(booking.location),
      ].join("\n"),
    });
  }

  sendMail({
    to: HOTEL_EMAIL,
    subject: "Payment recorded — " + booking.ref + " (" + loc.name + ")",
    text: [
      "A payment was recorded at " + loc.name + ".",
      "",
      ...lines,
      "Guest: " + (guest?.name || "—"),
      "Recorded by: " + (payment.recordedByName || "—"),
    ].join("\n"),
  });
}

/** A prospective guest submitted a request on the public website. */
function notifyBookingRequestSubmitted(reqDoc) {
  const loc = LOCATIONS[reqDoc.location];
  const lines = [
    "Reference: " + reqDoc.reference,
    "Room type: " + reqDoc.roomType,
    "Check-in: " + reqDoc.checkIn,
    "Check-out: " + reqDoc.checkOut,
    "Nights: " + reqDoc.nights,
    "Quoted total: " + money(reqDoc.quotedTotal),
  ];

  if (reqDoc.guestEmail) {
    sendMail({
      to: reqDoc.guestEmail,
      subject: "We received your request — " + reqDoc.reference,
      text: [
        "Hello " + reqDoc.guestName + ",",
        "",
        "Thank you for your interest in " + loc.name + ". We have received your request and",
        "will be in touch shortly to confirm your room.",
        "",
        ...lines,
        "",
        "No room is held yet — we will call you to confirm.",
        "",
        footer(reqDoc.location),
      ].join("\n"),
    });
  }

  sendMail({
    to: HOTEL_EMAIL,
    subject: "New website request — " + reqDoc.reference + " (" + loc.name + ")",
    text: [
      "A new booking request came in from the website for " + loc.name + ".",
      "",
      ...lines,
      "Guest: " + reqDoc.guestName,
      "Phone: " + reqDoc.guestPhone,
      "Email: " + (reqDoc.guestEmail || "—"),
      reqDoc.specialRequests ? "Special requests: " + reqDoc.specialRequests : null,
    ].filter(Boolean).join("\n"),
  });
}

module.exports = { notifyBookingConfirmed, notifyPaymentRecorded, notifyBookingRequestSubmitted };
