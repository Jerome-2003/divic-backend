/**
 * Who is supposed to be working, and when.
 *
 * A roster is seven entries at most — one per weekday — each a start and an end
 * time. A day with no entry is a day off, which is why this is a list rather
 * than a fixed array of seven: "not working Tuesdays" should be the absence of
 * a row, not a row that has to mean nothing.
 *
 * The case that makes this more than a comparison is the night shift. A bar
 * closes at two in the morning, so a Friday shift of 18:00 to 02:00 is worked
 * partly on Saturday. Stored as Friday 18:00–02:00 and understood here as
 * wrapping past midnight: at one o'clock on Saturday morning the person on duty
 * is the one rostered for Friday night, and anyone asking "who should be here
 * now" has to be told that rather than "nobody".
 */

const { minutesNow, weekdayOf } = require("../utils/day");

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Rosters read Monday first, which is how everyone says the week aloud. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""));

/** "08:30" -> 510. */
function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

/** A shift that ends at or before it starts runs through midnight. */
const wrapsMidnight = (shift) => minutesOf(shift.endsAt) <= minutesOf(shift.startsAt);

/** How long a shift lasts, in minutes, counting the wrap. */
function lengthOf(shift) {
  const start = minutesOf(shift.startsAt);
  const end = minutesOf(shift.endsAt);
  return end > start ? end - start : 1440 - start + end;
}

/**
 * Whether somebody is rostered on at a given moment, and which shift it is.
 *
 * Checks today's shift and yesterday's, because yesterday's may still be
 * running: that is the whole of the night-shift problem.
 */
function onRosterAt(shifts, at = new Date()) {
  const list = shifts || [];
  if (!list.length) return { on: false, shift: null };

  const day = weekdayOf(at);
  const mins = minutesNow(at);
  const yesterday = (day + 6) % 7;

  const todays = list.find((s) => s.day === day);
  if (todays) {
    const start = minutesOf(todays.startsAt);
    const end = minutesOf(todays.endsAt);
    if (wrapsMidnight(todays) ? mins >= start : mins >= start && mins < end) {
      return { on: true, shift: todays };
    }
  }

  // Still on last night's shift, in the small hours of the morning after.
  const last = list.find((s) => s.day === yesterday);
  if (last && wrapsMidnight(last) && mins < minutesOf(last.endsAt)) {
    return { on: true, shift: last };
  }

  return { on: false, shift: null };
}

/** Validation for a roster a manager has just typed. */
function badRoster(shifts) {
  if (shifts === undefined) return null;
  if (!Array.isArray(shifts)) return "Send the shifts as a list.";
  if (shifts.length > 7) return "There are only seven days in a week.";

  const seen = new Set();
  for (const s of shifts) {
    if (!Number.isInteger(s?.day) || s.day < 0 || s.day > 6) return "Each shift needs a day of the week.";
    if (seen.has(s.day)) return "There are two shifts on " + DAYS[s.day] + ". One a day.";
    seen.add(s.day);
    if (!isTime(s.startsAt) || !isTime(s.endsAt)) {
      return DAYS[s.day] + " needs a start and an end time, as HH:MM.";
    }
    // A shift of exactly zero length is a typo every time; a wrap is not.
    if (s.startsAt === s.endsAt) {
      return DAYS[s.day] + " starts and ends at the same time. For a full day, use 00:00 to 23:59.";
    }
  }
  return null;
}

/** Tidied, and in the order a week is read. */
function cleanRoster(shifts) {
  return (shifts || [])
    .map((s) => ({ day: s.day, startsAt: s.startsAt, endsAt: s.endsAt }))
    .sort((a, b) => WEEK_ORDER.indexOf(a.day) - WEEK_ORDER.indexOf(b.day));
}

module.exports = {
  DAYS, WEEK_ORDER, minutesOf, wrapsMidnight, lengthOf,
  onRosterAt, badRoster, cleanRoster, isTime,
};
