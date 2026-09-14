/**
 * Who is supposed to be working, and when.
 *
 * A hotel does not close, so the week is not a grid of arbitrary times: it is
 * two shifts going round the clock, and a person is on one of them or off. The
 * property sets the changeover — when mornings start, and when nights do — and
 * each shift runs until the other begins.
 *
 * Two times rather than four is the whole design. Four free times can be set to
 * leave an hour at dawn covered by nobody, or two hours covered by both, and
 * neither mistake announces itself; it surfaces weeks later as an argument
 * about who was meant to be there. Two times cannot express a gap.
 *
 * The night shift crosses midnight, which is not an edge case here but half of
 * every day. At one in the morning the person due is the one rostered for last
 * night, and anyone asking has to be told that rather than "nobody".
 */

const { minutesNow, weekdayOf } = require("../utils/day");

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Rosters read Monday first, which is how the week is said aloud. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const SHIFT_KEYS = ["morning", "night"];

const DEFAULT_TIMES = { morningStartsAt: "07:00", nightStartsAt: "19:00" };

const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""));

/** "08:30" -> 510. */
function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

/** The window each shift covers, derived from the two changeover times. */
function windowsFor(times = DEFAULT_TIMES) {
  const morning = times.morningStartsAt || DEFAULT_TIMES.morningStartsAt;
  const night = times.nightStartsAt || DEFAULT_TIMES.nightStartsAt;
  return {
    morning: { key: "morning", name: "Morning", startsAt: morning, endsAt: night },
    night: { key: "night", name: "Night", startsAt: night, endsAt: morning },
  };
}

/** A shift that ends at or before it starts runs through midnight. */
const wrapsMidnight = (w) => minutesOf(w.endsAt) <= minutesOf(w.startsAt);

/** How long a shift lasts, in minutes, counting the wrap. */
function lengthOf(w) {
  const start = minutesOf(w.startsAt);
  const end = minutesOf(w.endsAt);
  return end > start ? end - start : 1440 - start + end;
}

/** Is this minute-of-day inside the window? */
function covers(w, mins) {
  const start = minutesOf(w.startsAt);
  const end = minutesOf(w.endsAt);
  return wrapsMidnight(w) ? mins >= start || mins < end : mins >= start && mins < end;
}

/**
 * Whether somebody is rostered on at a given moment, and on which shift.
 *
 * Checks today's assignment and yesterday's, because a night shift started
 * yesterday is still running in the small hours — that is half of every day at
 * a hotel, not an edge case.
 */
function onRosterAt(shifts, times, at = new Date()) {
  const list = (shifts || []).filter((s) => SHIFT_KEYS.includes(s.shift));
  if (!list.length) return { on: false, shift: null, window: null };

  const w = windowsFor(times);
  const day = weekdayOf(at);
  const mins = minutesNow(at);

  const todays = list.find((s) => s.day === day);
  if (todays && covers(w[todays.shift], mins)) {
    // A wrapping shift covers both ends of the day; only the part at or after
    // its start belongs to today's assignment.
    const window = w[todays.shift];
    if (!wrapsMidnight(window) || mins >= minutesOf(window.startsAt)) {
      return { on: true, shift: todays.shift, window };
    }
  }

  // Still on last night's shift, in the morning after.
  const last = list.find((s) => s.day === (day + 6) % 7);
  if (last) {
    const window = w[last.shift];
    if (wrapsMidnight(window) && mins < minutesOf(window.endsAt)) {
      return { on: true, shift: last.shift, window };
    }
  }

  return { on: false, shift: null, window: null };
}

/** Validation for a roster a manager has just set. */
function badRoster(shifts) {
  if (shifts === undefined) return null;
  if (!Array.isArray(shifts)) return "Send the shifts as a list.";
  if (shifts.length > 7) return "There are only seven days in a week.";

  const seen = new Set();
  for (const s of shifts) {
    if (!Number.isInteger(s?.day) || s.day < 0 || s.day > 6) return "Each shift needs a day of the week.";
    if (seen.has(s.day)) return "There are two shifts on " + DAYS[s.day] + ". One a day.";
    seen.add(s.day);
    if (!SHIFT_KEYS.includes(s.shift)) {
      return DAYS[s.day] + " must be the morning shift or the night shift.";
    }
  }
  return null;
}

/** Validation for the two changeover times. */
function badTimes({ morningStartsAt, nightStartsAt } = {}) {
  if (!isTime(morningStartsAt) || !isTime(nightStartsAt)) {
    return "Give both changeover times as HH:MM.";
  }
  if (morningStartsAt === nightStartsAt) {
    return "The two shifts cannot change over at the same moment — one of them would be the whole day and the other nothing.";
  }
  return null;
}

/** Tidied, and in the order a week is read. */
function cleanRoster(shifts) {
  return (shifts || [])
    .filter((s) => SHIFT_KEYS.includes(s.shift))
    .map((s) => ({ day: s.day, shift: s.shift }))
    .sort((a, b) => WEEK_ORDER.indexOf(a.day) - WEEK_ORDER.indexOf(b.day));
}

module.exports = {
  DAYS, WEEK_ORDER, SHIFT_KEYS, DEFAULT_TIMES,
  minutesOf, windowsFor, wrapsMidnight, lengthOf, covers,
  onRosterAt, badRoster, badTimes, cleanRoster, isTime,
};
