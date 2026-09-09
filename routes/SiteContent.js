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

    // One field for media, not two. A popup's image and a banner's flyer are
    // the same kind of thing; a second field that also means "the picture for
    // this item" is exactly the duplication that causes a bug six months from
    // now when someone updates one and not the other.
    mediaType: { type: String, enum: ["none", "image", "video"], default: "none" },
    mediaUrl: { type: String, trim: true },   // an https image or video URL
    caption: { type: String, trim: true, maxlength: 200 },

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
