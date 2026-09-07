const mongoose = require("mongoose");
const { CHARGE_SETTLEMENTS } = require("../utils/constants");

// Money taken at a facility. Deliberately just a description and an amount —
// this is not a menu or a product catalogue, and it is not meant to become one.
const chargeSchema = new mongoose.Schema(
  {
    // Present for charge-to-room, absent for a walk-in who paid on the spot.
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", index: true },
    location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },
    facility: { type: mongoose.Schema.Types.ObjectId, ref: "Facility", required: true, index: true },

    description: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 1 },

    settlement: { type: String, enum: CHARGE_SETTLEMENTS, required: true },
    // Set when settlement is "paid" — the till payment this charge produced.
    payment: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },

    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // Charges are voided with a reason, never deleted. The activity log has to
    // stay truthful, and the person who takes the money must not be able to
    // make it disappear — voiding is a manager decision.
    voided: { type: Boolean, default: false },
    voidReason: String,
  },
  { timestamps: true }
);

// Drives the folio maths and the per-shift charge list.
chargeSchema.index({ booking: 1, voided: 1, settlement: 1 });
chargeSchema.index({ facility: 1, createdAt: -1 });

module.exports = mongoose.model("Charge", chargeSchema);
