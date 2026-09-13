const mongoose = require("mongoose");

/**
 * One member's subscription term at the gym.
 *
 * The plan's name, length and price are copied in at sign-up rather than only
 * referenced. A plan whose price changes next quarter must not retroactively
 * change what this member agreed to pay, and the record has to stay readable if
 * the plan is later retired.
 *
 * Renewing does not edit this document — it creates the next one. That keeps a
 * member's history intact instead of collapsing every term into one row whose
 * dates keep moving.
 */
const membershipSchema = new mongoose.Schema(
  {
    location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },
    facility: { type: mongoose.Schema.Types.ObjectId, ref: "Facility", required: true, index: true },

    memberName: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },

    plan: { type: mongoose.Schema.Types.ObjectId, ref: "MembershipPlan" },
    planName: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },

    startsOn: { type: String, required: true },   // "2026-09-13", matching Booking's date style
    endsOn: { type: String, required: true },

    settlement: { type: String, enum: ["room", "paid"], required: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking" },
    charge: { type: mongoose.Schema.Types.ObjectId, ref: "Charge" },

    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// "Who is a current member" is a date comparison against endsOn, so it leads.
membershipSchema.index({ facility: 1, endsOn: -1 });
membershipSchema.index({ facility: 1, phone: 1 });

module.exports = mongoose.model("Membership", membershipSchema);
