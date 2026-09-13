const mongoose = require("mongoose");

/**
 * One person's visit to the pool or the gym: who came in, what they paid, and
 * whether they have left yet.
 *
 * The entry fee is charged to everyone, in-house or not — an in-house guest can
 * put it on their room, a walk-in pays at the desk. Either way it becomes a
 * Charge, so pool and gym takings land in billing and analytics the same way
 * bar takings do rather than sitting in a separate silo nobody reconciles.
 */
const facilityVisitSchema = new mongoose.Schema(
  {
    location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },
    facility: { type: mongoose.Schema.Types.ObjectId, ref: "Facility", required: true, index: true },

    guestName: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    people: { type: Number, min: 1, default: 1 },

    // Present when the visitor is staying at the hotel and put it on their room.
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", index: true },

    amount: { type: Number, required: true, min: 0 },
    settlement: { type: String, enum: ["room", "paid"], required: true },
    charge: { type: mongoose.Schema.Types.ObjectId, ref: "Charge" },

    // Absent while they are still in. The pool screen's "who is here now" list
    // is exactly the set of visits without one.
    leftAt: Date,

    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// Drives "currently in" and the day's visit list.
facilityVisitSchema.index({ facility: 1, leftAt: 1, createdAt: -1 });

module.exports = mongoose.model("FacilityVisit", facilityVisitSchema);
