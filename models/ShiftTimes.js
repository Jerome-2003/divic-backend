const mongoose = require("mongoose");

/**
 * When the two shifts change over at a property.
 *
 * A hotel does not close, so its day is not a working day with edges — it is a
 * circle with two people on it. Which means the manager does not set four
 * times, they set two: when the morning comes on, and when the night does.
 * Each shift runs until the other starts.
 *
 * That is worth more than the keystrokes it saves. Four free times can be set
 * to leave an hour at dawn covered by nobody, or two hours covered by both,
 * and neither mistake announces itself — it shows up weeks later as an
 * argument about who was supposed to be there. Two times cannot express a gap.
 *
 * Per property, like rates and facilities: a manager who runs one building
 * sets that building's hours, and the two need not match.
 */
const shiftTimesSchema = new mongoose.Schema(
  {
    location: { type: String, enum: ["exclusive", "urban"], required: true, unique: true },
    // "07:00" — the morning shift runs from here until the night starts.
    morningStartsAt: { type: String, required: true, default: "07:00" },
    // "19:00" — the night shift runs from here until the morning starts,
    // through midnight, which is the ordinary case and not an error.
    nightStartsAt: { type: String, required: true, default: "19:00" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ShiftTimes", shiftTimesSchema);
