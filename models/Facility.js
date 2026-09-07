const mongoose = require("mongoose");
const { FACILITY_TYPES, FACILITY_STATUSES } = require("../utils/constants");

const facilitySchema = new mongoose.Schema(
  {
    location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },
    name: { type: String, required: true, trim: true },      // "Indoor pool"
    slug: { type: String, required: true, trim: true },      // "indoor-pool"
    type: { type: String, enum: FACILITY_TYPES, required: true },

    // Whether this facility can post charges at all. True for bars and the
    // restaurant, false for the pool and the gym — a gym attendant is never
    // shown a till, and the server refuses a charge from one either way.
    sellsItems: { type: Boolean, default: false },

    status: { type: String, enum: FACILITY_STATUSES, default: "open" },
    statusNote: { type: String, trim: true },                // "Pump being serviced, back Friday"
    openingHours: { type: String, trim: true },              // "6am – 10pm"

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// A facility slug is unique within its property, not across both — the bar at
// Divic Urban and the indoor bar at Divic Exclusive are different facilities,
// exactly as room numbers work in models/Room.js.
facilitySchema.index({ location: 1, slug: 1 }, { unique: true });

module.exports = mongoose.model("Facility", facilitySchema);
