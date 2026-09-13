const Discount = require("../models/Discount");

/**
 * What a stay actually costs once the property's live offers are taken off it.
 *
 * There are six places in this app that turn a nightly rate into a total: the
 * website's rate cards, its availability list, its quote, the request it
 * lodges, the booking a receptionist types at the desk, and the re-rate when a
 * guest is moved to a different room. All six have to agree, because a guest
 * who is quoted one figure on the website and charged another at checkout has
 * caught the hotel in what looks exactly like a lie. So the arithmetic lives
 * here once and every one of them calls it.
 *
 * The user-facing rule is the plain one: offers stack. If a property is
 * running 15% off December and ₦10,000 off stays of four nights or more, a
 * five-night December booking gets both. Percentages come off first and the
 * flat amounts after, which is the order that makes the percentage mean what
 * it says on the website — a percentage of the room rate, not of some already
 * reduced number a guest cannot see.
 */

const MAX_PERCENT = 90; // Nothing this business sells is ever ninety per cent off.

/** Whether an offer applies to this particular stay. */
function applies(d, { roomType, checkIn, nights }) {
  if (!d.active) return false;
  if (d.roomTypes?.length && !d.roomTypes.includes(roomType)) return false;
  if (nights < (d.minNights || 1)) return false;
  // Judged on the night the guest arrives. A stay that begins inside the offer
  // window gets the offer — splitting a booking across the boundary and
  // pro-rating it would be correct and completely incomprehensible to both the
  // guest and the receptionist explaining it.
  if (d.startsOn && checkIn < d.startsOn) return false;
  if (d.endsOn && checkIn > d.endsOn) return false;
  return true;
}

/**
 * Price one stay. `discounts` is the property's offers — already fetched, so a
 * caller pricing a whole rate card hits the database once rather than per row.
 *
 * Returns the gross, what came off, and the net the guest pays. Every caller
 * stores or shows the net as its total, so nothing downstream — folios,
 * balances, analytics — has to learn that discounts exist.
 */
function priceStay({ rate, nights, roomType, checkIn, discounts = [] }) {
  const gross = Math.round(rate * nights);
  const mine = discounts.filter((d) => applies(d, { roomType, checkIn, nights }));

  const applied = [];
  let percent = 0;
  mine.filter((d) => d.kind === "percent").forEach((d) => { percent += d.value; });
  percent = Math.min(percent, MAX_PERCENT);

  let off = 0;
  if (percent > 0) {
    // Each percentage offer is credited with its share of one combined
    // reduction, so two 10% offers take 20% off in total rather than 19% —
    // and the lines still add up to the figure actually taken off.
    const combined = Math.round((gross * percent) / 100);
    off += combined;
    const pcts = mine.filter((d) => d.kind === "percent");
    let allocated = 0;
    pcts.forEach((d, i) => {
      const share = i === pcts.length - 1
        ? combined - allocated
        : Math.round((combined * d.value) / percent);
      allocated += share;
      applied.push({ name: d.name, kind: "percent", value: d.value, amount: share });
    });
  }

  mine.filter((d) => d.kind === "fixed").forEach((d) => {
    // Never take more off than is left; two generous offers on a cheap night
    // must not produce a negative bill.
    const amount = Math.max(0, Math.min(d.value, gross - off));
    off += amount;
    applied.push({ name: d.name, kind: "fixed", value: d.value, amount });
  });

  return {
    gross,
    discountTotal: off,
    total: gross - off,
    discounts: applied.filter((a) => a.amount > 0),
  };
}

/** Every offer at a property that could apply to something, live now. */
async function liveDiscounts(location) {
  return Discount.find({ location, active: true }).sort({ createdAt: -1 }).lean();
}

/** The shape the public website reads: readable, with no internal fields. */
function publicDiscount(d) {
  return {
    id: String(d._id),
    name: d.name,
    blurb: d.blurb || null,
    kind: d.kind,
    value: d.value,
    // Written out once here so the website, the PMS and a receptionist on the
    // phone all describe the same offer in the same words.
    label: d.kind === "percent" ? d.value + "% off" : "₦" + d.value.toLocaleString("en-NG") + " off",
    roomTypes: d.roomTypes || [],
    minNights: d.minNights || 1,
    startsOn: d.startsOn || null,
    endsOn: d.endsOn || null,
  };
}

module.exports = { priceStay, liveDiscounts, publicDiscount, applies, MAX_PERCENT };
