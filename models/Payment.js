const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },
    amount: { type: Number, required: true, min: 1 },
    method: { type: String, enum: ["paystack", "transfer", "cash", "pos"], required: true },

    // Paystack only. `verified` is set by the server after calling Paystack's
    // verify endpoint — never trusted from the client.
    paystackReference: { type: String, index: true, sparse: true },
    verified: { type: Boolean, default: false },
    verifiedAt: Date,
    gatewayResponse: mongoose.Schema.Types.Mixed,

    note: String,
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    voided: { type: Boolean, default: false },
    voidReason: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
