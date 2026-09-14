const mongoose = require("mongoose");

/**
 * A shift somebody actually worked, as opposed to the one they were rostered
 * for. The two are different questions and the gap between them is the whole
 * point: who is here, who should be here, and who is still signed on at four
 * in the morning because they forgot to end it.
 *
 * Opened when they sign in and closed when they say so — signing out is not
 * the same as going home. A receptionist moving from the desk computer to
 * their phone signs out twice in a minute and has not finished working either
 * time, so ending a shift is asked for rather than assumed.
 */
const shiftSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // Copied in rather than looked up: a person's property can be changed
    // later, and a shift worked last month was worked where it was worked.
    location: { type: String, enum: ["exclusive", "urban", "all"], required: true },

    startedAt: { type: Date, required: true, default: Date.now },
    endedAt: Date,
    // Usually themselves. A manager can close a shift somebody left running,
    // and it should be visible that they did.
    endedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    /**
     * What the roster said when this shift opened, copied in at the time.
     *
     * A roster is a live setting a manager edits; a shift is a record of a day
     * that has happened. Reading "was she supposed to be in on the 3rd?" off
     * today's roster answers a different question every time somebody changes
     * it, so the answer is written down when it is still true.
     */
    wasRostered: { type: Boolean, default: false },
    // Which shift, and the hours it ran to on the day — the changeover times
    // are a live setting and a manager moving them next month must not rewrite
    // what last month's shifts were.
    rosteredShift: { type: String, enum: ["morning", "night"] },
    rosteredStart: String,
    rosteredEnd: String,
  },
  { timestamps: true }
);

// The question asked constantly: is this person on shift right now.
shiftSchema.index({ user: 1, endedAt: 1 });
shiftSchema.index({ location: 1, startedAt: -1 });

module.exports = mongoose.model("Shift", shiftSchema);
