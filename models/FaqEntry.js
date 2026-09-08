const mongoose = require("mongoose");

// What the website's public assistant is allowed to know. Managers write these
// in the PMS. The assistant answers from these plus published property
// information, and from nothing else.
const faqEntrySchema = new mongoose.Schema(
  {
    question: { type: String, required: true, trim: true, maxlength: 200 },
    answer: { type: String, required: true, trim: true, maxlength: 1200 },
    category: { type: String, trim: true, default: "General" },
    location: { type: String, enum: ["exclusive", "urban", "both"], default: "both", index: true },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

faqEntrySchema.index({ location: 1, order: 1 });

module.exports = mongoose.model("FaqEntry", faqEntrySchema);
