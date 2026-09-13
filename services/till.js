/**
 * The small pieces of till arithmetic that are easy to get quietly wrong.
 *
 * Both of these looked like one-liners inside the route and both have a wrong
 * version that nothing would catch: a state word that reports a split bill as
 * simply "paid" when half of it is sitting unpaid on somebody's room, and a
 * takings breakdown that files a whole table under one payment method when it
 * was settled two ways. Neither shows up as an error — they show up as a
 * manager's figures being wrong, weeks later, with no way to tell.
 */

/**
 * One state word for an order, because the person at the till thinks in one.
 *
 * Unpaid, paid, or charged to a room — and voided, which is none of those and
 * has to be visible rather than merely absent. The stored fields say the same
 * thing in two (status plus settlement), which is right for a database and
 * wrong for a badge on a card.
 *
 * A split that touched a room at all counts as charged to a room: there is
 * money outstanding on somebody's folio, and that is what anyone reading the
 * badge needs to know.
 */
function tabState(t) {
  if (t.voided) return "voided";
  if (t.status !== "settled") return "unpaid";
  const parts = t.parts || [];
  if (parts.length > 1) return parts.some((p) => p.settlement === "room") ? "room" : "paid";
  return t.settlement === "room" ? "room" : "paid";
}

/**
 * How a settled tab was actually paid for, one entry per way.
 *
 * An unsplit bill has no parts recorded — everything settled before splits
 * existed, and every ordinary bill since — so it is read from the fields that
 * have always held it. This is the one place that fallback lives; doing it at
 * each call site is how half of them end up forgetting.
 */
function partsOf(tab) {
  if ((tab.parts || []).length) return tab.parts;
  return [{ settlement: tab.settlement, amount: tab.total, paymentMethod: null }];
}

/** Which bucket a part's money belongs in: the room, or the way it was paid. */
function methodKey(part) {
  return part.settlement === "room" ? "room" : (part.paymentMethod || "cash");
}

module.exports = { tabState, partsOf, methodKey };
