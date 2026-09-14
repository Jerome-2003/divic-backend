const Shift = require("../models/Shift");
const { onRosterAt } = require("./roster");

/**
 * Opening and closing the shift somebody is actually working.
 *
 * A shift opens when they sign in, because that is the only moment the system
 * can know for certain that a person has arrived. It does not close when they
 * sign out: a receptionist moving from the desk computer to their phone signs
 * out twice in a minute and has gone home neither time. Closing is asked for.
 */

/** The shift this person has open, if any. */
const openShiftFor = (userId) =>
  Shift.findOne({ user: userId, endedAt: { $exists: false } }).sort({ startedAt: -1 });

/**
 * Opens one if none is open, and returns it either way.
 *
 * Signing in twice in a morning must not start a second shift — the first is
 * still running and this is the same day's work. Idempotent for that reason.
 */
async function startShift(user) {
  const existing = await openShiftFor(user._id);
  if (existing) return { shift: existing, opened: false };

  // What the roster said right now, written down while it is still true. A
  // manager editing the roster next week must not change what today looked like.
  const { on, shift: rostered } = onRosterAt(user.shifts, new Date());

  const shift = await Shift.create({
    user: user._id,
    location: user.location,
    startedAt: new Date(),
    wasRostered: on,
    rosteredStart: rostered?.startsAt,
    rosteredEnd: rostered?.endsAt,
  });
  return { shift, opened: true };
}

/** Closes whatever is open. `by` is usually them; a manager may close another's. */
async function endShift(userId, by) {
  const shift = await openShiftFor(userId);
  if (!shift) return null;
  shift.endedAt = new Date();
  shift.endedBy = by;
  await shift.save();
  return shift;
}

/** How long a shift has run, in minutes. */
const minutesWorked = (shift) =>
  Math.max(0, Math.round(((shift.endedAt || new Date()) - shift.startedAt) / 60000));

module.exports = { openShiftFor, startShift, endShift, minutesWorked };
