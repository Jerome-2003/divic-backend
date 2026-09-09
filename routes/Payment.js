const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    // Optional: a facility charge settled on the spot by a walk-in customer is
    // a payment with no folio behind it. Every folio aggregation therefore has
    // to filter these out rather than assume a booking is present.
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", index: true },
    location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },
    amount: { type: Number, required: true, min: 1 },

    // When the guest pays the Paystack fee on top, `amount` is what they were
    // charged. The hotel's revenue is `netAmount` — analytics must never count
    // the processing fee as room revenue.
    feeAmount: { type: Number, default: 0 },
    netAmount: { type: Number },
    method: { type: String, enum: ["paystack", "transfer", "cash", "pos"], required: true },

    // Paystack only. `verified` is set by the server after calling Paystack's
    // verify endpoint — never trusted from the client.
    paystackReference: { type: String, index: true, sparse: true },
    verified: { type: Boolean, default: false },
    verifiedAt: Date,
    gatewayResponse: mongoose.Schema.Types.Mixed,

    // Set when this payment came off a facility till rather than the front desk.
    facility: { type: mongoose.Schema.Types.ObjectId, ref: "Facility", index: true, sparse: true },

    note: String,
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    voided: { type: Boolean, default: false },
    voidReason: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
