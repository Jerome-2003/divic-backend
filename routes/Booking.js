const mongoose = require("mongoose");
const { BOOKING_STATUSES } = require("../utils/constants");

const bookingSchema = new mongoose.Schema(
  {
    ref: { type: String, required: true, unique: true },   // DX-4821 / DU-9114
    location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },
    guest: { type: mongoose.Schema.Types.ObjectId, ref: "Guest", required: true },
    // Room is optional in exactly one case: payment succeeded but every room of
    // that type was taken during checkout. The booking and the money are real,
    // so the booking must exist — flagged for a human to place by hand.
    room: { type: mongoose.Schema.Types.ObjectId, ref: "Room" },
    roomNumber: { type: String },  // denormalised for fast lists
    roomType: { type: String, required: true },

    // Dates are stored as YYYY-MM-DD strings, not Date objects. A hotel night is
    // a calendar day, not an instant — storing Dates invites timezone bugs where
    // a booking made at 11pm WAT lands on the wrong day in UTC.
    checkIn: { type: String, required: true },
    checkOut: { type: String, required: true },

    nights: { type: Number, required: true, min: 1 },
    rate: { type: Number, required: true, min: 0 },   // nightly rate at time of booking
    totalCharge: { type: Number, required: true, min: 0 },

    adults: { type: Number, default: 1, min: 1 },
    children: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: BOOKING_STATUSES, default: "confirmed", index: true },
    source: { type: String, enum: ["walk-in", "website", "phone", "corporate"], default: "walk-in" },
    specialRequests: { type: String, trim: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    checkedInAt: Date,
    checkedOutAt: Date,
    cancelledAt: Date,
    cancelReason: String,

    // Set when a booking originated from a public website request.
    fromRequest: { type: mongoose.Schema.Types.ObjectId, ref: "BookingRequest" },

    // The room was chosen by the system, not a person. Shown in the PMS so a
    // receptionist knows nobody weighed it up.
    autoAssigned: { type: Boolean, default: false },
    // Paid, but no room could be given. The most urgent state in this system.
    needsAttention: { type: Boolean, default: false, index: true },
    attentionReason: String,
    dateChanges: [{
      fromCheckIn: String, fromCheckOut: String,
      toCheckIn: String, toCheckOut: String,
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      reason: String, at: { type: Date, default: Date.now },
    }],
    roomChanges: [{
      from: String, to: String, reason: String,
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      at: { type: Date, default: Date.now },
    }],
  },
  { timestamps: true }
);

// Drives the availability query — see services/availability.js
bookingSchema.index({ location: 1, roomNumber: 1, status: 1, checkIn: 1, checkOut: 1 });

module.exports = mongoose.model("Booking", bookingSchema);
