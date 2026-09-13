const mongoose = require("mongoose");

/**
 * An offer against a property's published rates.
 *
 * Two things are true of a discount at once, and the model has to serve both.
 * On the website it is a thing a guest reads — a name, a line of copy, a
 * headline saving — and it belongs in its own section, not buried in a price.
 * At the moment of booking it is arithmetic, and it has to come off the total
 * silently and correctly whether the guest noticed the offer or not. Keeping
 * one record for both is what stops the two drifting: there is no way to
 * advertise 15% off and charge full price, because the same document is read
 * by the page and by the till.
 *
 * A manager chooses per discount whether it is a percentage or a flat amount,
 * because both are things hotels genuinely sell — "20% off in the low season"
 * and "₦20,000 off a week" are different offers, and forcing one into the
 * other's shape would mean doing the sums in your head before typing them in.
 */
const discountSchema = new mongoose.Schema(
  {
    location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },

    // What the guest reads on the website.
    name: { type: String, required: true, trim: true, maxlength: 80 },
    blurb: { type: String, trim: true, maxlength: 240 },

    kind: { type: String, enum: ["percent", "fixed"], required: true },
    // Per cent off the stay, or naira off the stay — never per night. A guest
    // reading "₦20,000 off" does not mean per night, and neither should we.
    value: { type: Number, required: true, min: 0 },

    // Empty means every room type at this property. Listing types narrows it.
    roomTypes: { type: [String], default: [] },
    minNights: { type: Number, default: 1, min: 1 },

    // Dates are YYYY-MM-DD strings, matching Booking — a hotel night is a
    // calendar day, and storing Dates invites the timezone bug where an offer
    // starting 1 December is live from 11pm on 30 November in Lagos.
    startsOn: { type: String },
    endsOn: { type: String },

    active: { type: Boolean, default: false },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

discountSchema.index({ location: 1, active: 1 });

module.exports = mongoose.model("Discount", discountSchema);
