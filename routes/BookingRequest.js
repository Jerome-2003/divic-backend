const mongoose = require("mongoose");

// What the public website POSTs. Deliberately NOT a Booking: an unverified
// stranger on the internet must never write straight into the live room
// inventory. A request holds no room until a receptionist accepts it, which is
// what stops the website from double-booking against a walk-in at the desk.
const bookingRequestSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true },  // WEB-2K4F9A

    location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },
    roomType: { type: String, required: true },

    checkIn: { type: String, required: true },   // YYYY-MM-DD
    checkOut: { type: String, required: true },
    nights: { type: Number, required: true, min: 1 },
    adults: { type: Number, default: 1, min: 1 },
    children: { type: Number, default: 0, min: 0 },

    guestName: { type: String, required: true, trim: true },
    guestPhone: { type: String, required: true, trim: true },
    guestEmail: { type: String, trim: true, lowercase: true },
    specialRequests: { type: String, trim: true, maxlength: 500 },

    quotedRate: { type: Number, required: true },     // rate shown on the website
    quotedTotal: { type: Number, required: true },

    // pending  — waiting on the front desk
    // accepted — converted into a Booking
    // declined — no room, or the guest could not be reached
    // expired  — auto-closed, arrival date passed with no action
    status: { type: String, enum: ["pending", "accepted", "declined", "expired"], default: "pending", index: true },

    payment: {
      required: { type: Boolean, default: false },
      paystackReference: { type: String, index: true, sparse: true },
      // Quoted split out so the fee stays auditable after the fact.
      roomTotal: Number,
      feeAmount: Number,
      amount: Number,               // total actually charged
      verified: { type: Boolean, default: false },
      verifiedAt: Date,
      initializedAt: Date,
      failureReason: String,
    },

    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    handledAt: Date,
    declineReason: String,
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking" },

    // Light abuse tracking for the public endpoint.
    sourceIp: String,
    userAgent: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("BookingRequest", bookingRequestSchema);
