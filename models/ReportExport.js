const mongoose = require("mongoose");

/**
 * A record that somebody took the month's or the year's report away.
 *
 * It exists so the prompt can stop. A manager who has downloaded September
 * should not be asked for September again every time they open the app, and
 * two managers at the same property are two separate people who each may want
 * their own copy — so this is per user rather than per property.
 *
 * Only named periods are recorded. An arbitrary range is a question somebody
 * asked once, not a document anyone files, so there is nothing to have
 * outstanding.
 */
const reportExportSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: ["month", "year"], required: true },
    // "2026-09" for a month, "2026" for a year.
    period: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// One record per person per period; asking twice is the bug this prevents.
reportExportSchema.index({ user: 1, kind: 1, period: 1 }, { unique: true });

module.exports = mongoose.model("ReportExport", reportExportSchema);
