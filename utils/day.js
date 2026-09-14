/**
 * When a day starts and ends at this hotel.
 *
 * Everything here used to work in UTC: `new Date().toISOString().slice(0, 10)`
 * for today, and `new Date(iso + "T00:00:00.000Z")` for the start of a day.
 * Lagos is an hour ahead of UTC, so the business day rolled over at 1am rather
 * than midnight. For the hour in between, a drink sold at half past twelve
 * counted toward the previous day's takings, the bar's "settled today" list
 * still showed last night's tables, and a guest arriving that morning was not
 * yet on the arrivals list. Every figure was consistent with every other, and
 * all of them were an hour out.
 *
 * So the day is defined once, here, in the hotel's own time. A date on its own
 * — a check-in, a check-out, the day an offer starts — stays a plain
 * YYYY-MM-DD string with no clock attached, which is the right shape for a
 * calendar day and immune to all of this. What needs care is the boundary
 * between such a date and a timestamp, and that is what dayStart and dayEnd are
 * for: they answer "which instants belong to the 14th of September here".
 *
 * The zone is a setting rather than a constant because a second property in
 * another country would otherwise be quietly wrong, and because a hard-coded
 * offset breaks in any zone that observes daylight saving. Lagos does not, but
 * the code should not be the reason that stays true.
 */

const TZ = process.env.HOTEL_TZ || "Africa/Lagos";

/**
 * How far ahead of UTC the zone is at a given instant, in milliseconds.
 *
 * Read from the zone itself rather than hard-coded, so this survives a change
 * of HOTEL_TZ and behaves correctly in a zone with daylight saving.
 */
function offsetMs(at) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at).reduce((a, p) => (p.type === "literal" ? a : { ...a, [p.type]: p.value }), {});

  // Some engines render midnight as hour 24 rather than 00.
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const asIfUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second),
  );
  return asIfUTC - at.getTime();
}

/** The calendar date a timestamp falls on, here. */
function dayOf(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  // en-CA renders as YYYY-MM-DD, which is the shape every date in this app has.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/** Today's date here — not UTC's idea of it. */
const today = () => dayOf(new Date());

/** The instant a local calendar day begins. */
function dayStart(iso) {
  const naive = new Date(iso + "T00:00:00Z");
  // The offset is sampled at the naive instant and applied; for a zone with
  // daylight saving that can land an hour out at the transition, so it is
  // re-sampled at the corrected instant and applied again.
  const once = new Date(naive.getTime() - offsetMs(naive));
  return new Date(naive.getTime() - offsetMs(once));
}

/**
 * The instant a local calendar day ends — which is the start of the next one,
 * and exclusive. A window that stops at 23:59:59 drops whatever happened in
 * the last second, and one that stops at midnight UTC drops an hour.
 */
const dayEnd = (iso) => dayStart(shiftDays(iso, 1));

/** A date this many days later or earlier. Pure calendar arithmetic. */
function shiftDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** How many days a window spans, both ends being dates. */
function daysBetween(from, to) {
  return Math.round(
    (new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000
  );
}

module.exports = { TZ, today, dayOf, dayStart, dayEnd, shiftDays, daysBetween, offsetMs };
