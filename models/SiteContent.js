const mongoose = require("mongoose");

/**
 * Promos, popups and announcements the owner publishes to the public website.
 *
 * Every field is structured on purpose. There is no HTML or rich-text field,
 * and one must not be added: this content is written by receptionists and
 * rendered on a public page, so an HTML field is a stored-XSS hole with a
 * friendly name. Title, body text, an image and one call to action cover every
 * promo and popup the hotel actually needs.
 */
const siteContentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },  // home-hero, promo-banner
    type: { type: String, enum: ["banner", "popup", "announcement", "section"], required: true },
    location: { type: String, enum: ["exclusive", "urban", "both"], default: "both", index: true },

    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, trim: true, maxlength: 800 },
    imageUrl: { type: String, trim: true },
    ctaLabel: { type: String, trim: true, maxlength: 40 },
    ctaHref: { type: String, trim: true },

    active: { type: Boolean, default: false },
    // Optional window, so a December promo can be written in November and
    // expire on its own rather than relying on someone remembering.
    startsAt: Date,
    endsAt: Date,
    priority: { type: Number, default: 0 },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

/** Live right now: switched on, and inside its window if it has one. */
siteContentSchema.statics.liveFilter = function (location) {
  const now = new Date();
  return {
    active: true,
    $and: [
      { $or: [{ startsAt: { $exists: false } }, { startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: { $exists: false } }, { endsAt: null }, { endsAt: { $gte: now } }] },
      { $or: [{ location: "both" }, { location }] },
    ],
  };
};

module.exports = mongoose.model("SiteContent", siteContentSchema);
