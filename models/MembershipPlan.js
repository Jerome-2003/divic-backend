const mongoose = require("mongoose");

/**
 * A gym subscription the manager defines: a name, how long it runs, what it
 * costs. Kept as data rather than as a fixed monthly/quarterly/annual list in
 * code, so a new offer does not need a developer.
 */
const membershipPlanSchema = new mongoose.Schema(
  {
    location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },
    facility: { type: mongoose.Schema.Types.ObjectId, ref: "Facility", required: true, index: true },

    name: { type: String, required: true, trim: true },     // "Monthly", "Annual"
    days: { type: Number, required: true, min: 1 },         // how long one term runs
    price: { type: Number, required: true, min: 0 },

    // Retired rather than deleted: members already on this plan keep a readable
    // record of what they signed up to.
    active: { type: Boolean, default: true },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

membershipPlanSchema.index({ facility: 1, active: 1, name: 1 });

module.exports = mongoose.model("MembershipPlan", membershipPlanSchema);
