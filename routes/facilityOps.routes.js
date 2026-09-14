const router = require("express").Router();
const MenuItem = require("../models/MenuItem");
const Tab = require("../models/Tab");
const FacilityVisit = require("../models/FacilityVisit");
const MembershipPlan = require("../models/MembershipPlan");
const Membership = require("../models/Membership");
const {
  requireAuth, requireModule, requireRole, requireOperational, requireAssignedFacility,
} = require("../middleware/auth");
const { logAction } = require("../services/audit");
const { settleFacilitySale, facilityClosedError } = require("../services/facilitySettlement");
const { tabState, partsOf, methodKey } = require("../services/till");

/**
 * The working screens for each kind of facility: a bar or restaurant's menu and
 * open tables, the pool and gym's visitor log, and gym subscriptions.
 *
 * Mounted alongside routes/facilities.routes.js rather than inside it — that
 * file owns what a facility *is* (its status, its till), this one owns what
 * happens in it during a shift.
 *
 * Money never stops here: every settled tab, entry fee and subscription becomes
 * a Charge through services/facilitySettlement.js, so billing, the guest folio
 * and analytics keep seeing one consistent picture.
 */
router.use(requireAuth);

const Booking = require("../models/Booking");
const Charge = require("../models/Charge");
const Payment = require("../models/Payment");

const clean = (s, max = 200) => String(s || "").trim().slice(0, max);

/**
 * Confirms a guest is in that room and gives back only what a bartender needs
 * to charge it: the room, the surname to say back to them, and the booking id.
 *
 * Deliberately the same three fields routes/facilities.routes.js returns from
 * its guest lookup, and for the same reason — confirming a guest exists is
 * legitimate, browsing guest records is not.
 */
async function inHouseRoom(facility, roomNumber) {
  const booking = await Booking.findOne({
    location: facility.location, roomNumber, status: "in-house",
  }).populate("guest", "name").lean();
  if (!booking) return null;
  return {
    roomNumber: booking.roomNumber,
    surname: String(booking.guest?.name || "").trim().split(/\s+/).pop() || "",
    bookingId: booking._id,
  };
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
// The hotel's day, not UTC's. A bar sells past midnight, so this is the file
// where an hour's drift is most visible: a round bought at half past twelve
// belongs to tonight's takings, not to yesterday's.
const { today, dayOf, dayStart, dayEnd, shiftDays } = require("../utils/day");

const itemJSON = (i) => ({
  id: i._id, name: i.name, category: i.category, price: i.price, active: i.active,
});

const nameOf = (u) => (u && u.name ? u.name : null);

const tabJSON = (t) => ({
  id: t._id,
  tableName: t.tableName,
  guestName: t.guestName || null,
  roomNumber: t.roomNumber || null,
  guestSurname: t.guestSurname || null,
  status: t.status,
  state: tabState(t),
  lines: (t.lines || []).map((l) => ({
    id: l._id, name: l.name, unitPrice: l.unitPrice, qty: l.qty,
    lineTotal: l.unitPrice * l.qty,
  })),
  total: (t.lines || []).reduce((s, l) => s + l.unitPrice * l.qty, 0),
  settlement: t.settlement || null,
  bookingId: t.booking ? String(t.booking) : null,
  // One entry for an ordinary bill, several for a split.
  parts: (t.parts || []).map((p) => ({
    settlement: p.settlement, amount: p.amount,
    paymentMethod: p.paymentMethod || null,
    roomNumber: p.roomNumber || null, guestSurname: p.guestSurname || null,
  })),
  split: (t.parts || []).length > 1,
  receiptNo: t.receiptNo || null,
  settledAt: t.settledAt || null,
  openedAt: t.createdAt,
  // Who did it. A shift with four people behind the bar needs every order to
  // say whose it was, both for questions afterwards and for the takings split.
  openedBy: nameOf(t.openedBy),
  settledBy: nameOf(t.settledBy),
  voided: !!t.voided,
  voidReason: t.voidReason || null,
  voidedBy: nameOf(t.voidedBy),
  voidedAt: t.voidedAt || null,
});

/* ------------------------------------------------------------------ */
/*  MENU — what this bar or restaurant sells                           */
/* ------------------------------------------------------------------ */

/** GET /api/facilities/:facilityId/menu — order entry reads this. */
router.get("/:facilityId/menu", requireModule("pos"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const all = String(req.query.all) === "true";
    const filter = { facility: req.facility._id };
    if (!all) filter.active = true;
    const items = await MenuItem.find(filter).sort({ category: 1, name: 1 }).lean();
    res.json(items.map(itemJSON));
  } catch (e) { next(e); }
});

/**
 * POST /api/facilities/:facilityId/menu   { name, category, price }
 *
 * Manager and owner only, and so is every other write below. What a facility
 * sells and for how much is a pricing decision, the same as room rates: a
 * bartender sells from the list, they do not write it — not the prices, not
 * the items, and not whether an item is on the list at all. Reading the menu
 * is open to whoever is working the till, because selling from it is their job.
 */
router.post("/:facilityId/menu", requireRole("manager", "owner"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const facility = req.facility;
    if (!facility.sellsItems) {
      return res.status(400).json({ error: facility.name + " does not sell items, so it has no menu." });
    }
    const name = clean(req.body.name, 80);
    const price = Number(req.body.price);
    const category = ["drink", "food", "other"].includes(req.body.category) ? req.body.category : "drink";
    if (name.length < 2) return res.status(400).json({ error: "Give the item a name." });
    if (!Number.isFinite(price) || price < 1) {
      return res.status(400).json({ error: "Enter a price of at least 1 naira." });
    }

    const item = await MenuItem.create({
      location: facility.location, facility: facility._id,
      name, category, price, updatedBy: req.user.id,
    });
    logAction(req, {
      action: "Added " + name + " at " + price + " naira to " + facility.name,
      entity: "MenuItem", entityId: item._id, location: facility.location, after: item.toObject(),
    });
    res.status(201).json(itemJSON(item));
  } catch (e) { next(e); }
});

/**
 * PATCH /api/facilities/:facilityId/menu/:itemId  { name?, price?, category?, active? }
 *
 * Including `active` — taking an item off the list is a change to the menu and
 * belongs with the rest of them, not on the order screen.
 */
router.patch("/:facilityId/menu/:itemId", requireRole("manager", "owner"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const item = await MenuItem.findOne({ _id: req.params.itemId, facility: req.facility._id });
    if (!item) return res.status(404).json({ error: "That item is not on this facility's menu." });
    const before = item.toObject();

    if (req.body.name !== undefined) {
      const name = clean(req.body.name, 80);
      if (name.length < 2) return res.status(400).json({ error: "Give the item a name." });
      item.name = name;
    }
    if (req.body.price !== undefined) {
      const price = Number(req.body.price);
      if (!Number.isFinite(price) || price < 1) {
        return res.status(400).json({ error: "Enter a price of at least 1 naira." });
      }
      item.price = price;
    }
    if (["drink", "food", "other"].includes(req.body.category)) item.category = req.body.category;
    if (typeof req.body.active === "boolean") item.active = req.body.active;
    item.updatedBy = req.user.id;
    await item.save();

    logAction(req, {
      action: "Updated menu item " + item.name + " at " + req.facility.name,
      entity: "MenuItem", entityId: item._id, location: req.facility.location,
      before, after: item.toObject(),
    });
    res.json(itemJSON(item));
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  TABS — a table's running order                                     */
/* ------------------------------------------------------------------ */

/**
 * GET /api/facilities/:facilityId/tabs?status=open|settled|all&date=YYYY-MM-DD
 *
 * The till's list of today's orders. "all" is what the screen actually asks
 * for — an open table and one settled ten minutes ago are both things the
 * person behind the bar is still thinking about, and making them two separate
 * fetches meant two lists that could disagree about the same order.
 */
router.get("/:facilityId/tabs", requireModule("pos"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const asked = req.query.status;
    const status = ["open", "settled", "all"].includes(asked) ? asked : "open";
    const date = isDate(req.query.date) ? req.query.date : today();
    const from = dayStart(date);
    const until = dayEnd(date);

    const filter = { facility: req.facility._id };
    if (status === "open") {
      filter.status = "open";
    } else if (status === "settled") {
      // A settled tab is history; only the chosen day's is worth loading.
      filter.status = "settled";
      filter.settledAt = { $gte: from, $lt: until };
    } else {
      // Everything still open, plus everything closed on the day asked about.
      filter.$or = [
        { status: "open" },
        { status: "settled", settledAt: { $gte: from, $lt: until } },
      ];
    }

    const tabs = await Tab.find(filter)
      .populate("openedBy settledBy voidedBy", "name")
      .sort({ updatedAt: -1 }).limit(200).lean();
    res.json(tabs.map(tabJSON));
  } catch (e) { next(e); }
});

/**
 * POST /api/facilities/:facilityId/tabs
 * { tableName, guestName?, roomNumber? } — opens a table.
 *
 * A room may be attached now rather than only at the moment of payment. It is
 * checked here the same way the till checks it: the guest must actually be in
 * house, and only their surname comes back. Optional throughout, because a bar
 * sells to people who are not staying in the hotel and always will.
 */
router.post("/:facilityId/tabs", requireModule("pos"), requireAssignedFacility(), requireOperational("facility"), async (req, res, next) => {
  try {
    const facility = req.facility;
    if (!facility.sellsItems) {
      return res.status(400).json({ error: facility.name + " does not take table orders." });
    }
    const closed = facilityClosedError(facility);
    if (closed) return res.status(closed.status).json({ error: closed.error });

    const tableName = clean(req.body.tableName, 40);
    if (tableName.length < 1) return res.status(400).json({ error: "Name the table." });

    const existing = await Tab.findOne({ facility: facility._id, tableName, status: "open" });
    if (existing) {
      return res.status(409).json({ error: tableName + " already has an open order. Add to that one instead." });
    }

    let room = null;
    if (clean(req.body.roomNumber, 10)) {
      room = await inHouseRoom(facility, clean(req.body.roomNumber, 10));
      if (!room) {
        return res.status(404).json({
          error: "Nobody is checked in to room " + clean(req.body.roomNumber, 10) + ". Open the table without a room and attach one later.",
        });
      }
    }

    const tab = await Tab.create({
      location: facility.location, facility: facility._id,
      tableName, guestName: clean(req.body.guestName, 120) || undefined,
      roomNumber: room ? room.roomNumber : undefined,
      guestSurname: room ? room.surname : undefined,
      booking: room ? room.bookingId : undefined,
      openedBy: req.user.id,
    });
    await tab.populate("openedBy", "name");
    res.status(201).json(tabJSON(tab));
  } catch (e) { next(e); }
});

/**
 * POST /api/facilities/:facilityId/tabs/:tabId/lines  { menuItemId, qty }
 *
 * The price is read from the menu here, never taken from the request — a client
 * that could name its own price is a client that can discount the bar at will.
 */
router.post("/:facilityId/tabs/:tabId/lines", requireModule("pos"), requireAssignedFacility(), requireOperational("facility"), async (req, res, next) => {
  try {
    const tab = await Tab.findOne({ _id: req.params.tabId, facility: req.facility._id });
    if (!tab) return res.status(404).json({ error: "That table order does not exist." });
    if (tab.status !== "open") return res.status(409).json({ error: "That table has already been settled." });

    const item = await MenuItem.findOne({ _id: req.body.menuItemId, facility: req.facility._id, active: true });
    if (!item) return res.status(404).json({ error: "That item is not on this facility's menu." });

    const qty = Math.max(1, Math.min(99, Number(req.body.qty) || 1));

    // Ordering the same thing again bumps the quantity rather than stacking a
    // second identical line — three separate "1 x Star" lines is how a receipt
    // becomes unreadable.
    const same = tab.lines.find((l) => String(l.menuItem) === String(item._id) && l.unitPrice === item.price);
    if (same) same.qty = Math.min(99, same.qty + qty);
    else {
      tab.lines.push({
        menuItem: item._id, name: item.name, unitPrice: item.price, qty, addedBy: req.user.id,
      });
    }
    tab.total = tab.computeTotal();
    await tab.save();
    res.json(tabJSON(tab));
  } catch (e) { next(e); }
});

/**
 * PATCH /api/facilities/:facilityId/tabs/:tabId/lines/:lineId  { qty }
 *
 * "They wanted three, not one" is the commonest correction at a bar, and
 * deleting the line and tapping the item three times is a poor way to make it.
 * A quantity of zero removes the line, so the minus button at the end of a
 * short order does the obvious thing rather than sticking at one.
 */
router.patch("/:facilityId/tabs/:tabId/lines/:lineId", requireModule("pos"), requireAssignedFacility(), requireOperational("facility"), async (req, res, next) => {
  try {
    const tab = await Tab.findOne({ _id: req.params.tabId, facility: req.facility._id });
    if (!tab) return res.status(404).json({ error: "That table order does not exist." });
    if (tab.status !== "open") return res.status(409).json({ error: "That table has already been settled." });

    const line = tab.lines.id(req.params.lineId);
    if (!line) return res.status(404).json({ error: "That line is not on this order." });

    const qty = Number(req.body.qty);
    if (!Number.isInteger(qty) || qty < 0 || qty > 99) {
      return res.status(400).json({ error: "A quantity must be a whole number between 0 and 99." });
    }
    if (qty === 0) line.deleteOne();
    else line.qty = qty;

    tab.total = tab.computeTotal();
    await tab.save();
    await tab.populate("openedBy settledBy", "name");
    res.json(tabJSON(tab));
  } catch (e) { next(e); }
});

/**
 * PATCH /api/facilities/:facilityId/tabs/:tabId  { roomNumber, guestName? }
 *
 * Attaching a room to a table already open, or correcting the one attached. A
 * guest who sat down as a walk-in and then says "put it on my room" is the
 * ordinary case, and it should not require closing the order and starting
 * again. An empty room number detaches.
 */
router.patch("/:facilityId/tabs/:tabId", requireModule("pos"), requireAssignedFacility(), requireOperational("facility"), async (req, res, next) => {
  try {
    const tab = await Tab.findOne({ _id: req.params.tabId, facility: req.facility._id });
    if (!tab) return res.status(404).json({ error: "That table order does not exist." });
    if (tab.status !== "open") return res.status(409).json({ error: "That table has already been settled." });

    if (req.body.guestName !== undefined) {
      tab.guestName = clean(req.body.guestName, 120) || undefined;
    }

    if (req.body.roomNumber !== undefined) {
      const asked = clean(req.body.roomNumber, 10);
      if (!asked) {
        tab.roomNumber = undefined;
        tab.guestSurname = undefined;
        tab.booking = undefined;
      } else {
        const room = await inHouseRoom(req.facility, asked);
        if (!room) return res.status(404).json({ error: "Nobody is checked in to room " + asked + "." });
        tab.roomNumber = room.roomNumber;
        tab.guestSurname = room.surname;
        tab.booking = room.bookingId;
      }
    }

    await tab.save();
    await tab.populate("openedBy settledBy", "name");
    res.json(tabJSON(tab));
  } catch (e) { next(e); }
});

/** DELETE /api/facilities/:facilityId/tabs/:tabId/lines/:lineId — a mis-key, before settling. */
router.delete("/:facilityId/tabs/:tabId/lines/:lineId", requireModule("pos"), requireAssignedFacility(), requireOperational("facility"), async (req, res, next) => {
  try {
    const tab = await Tab.findOne({ _id: req.params.tabId, facility: req.facility._id });
    if (!tab) return res.status(404).json({ error: "That table order does not exist." });
    if (tab.status !== "open") return res.status(409).json({ error: "That table has already been settled." });

    const line = tab.lines.id(req.params.lineId);
    if (!line) return res.status(404).json({ error: "That line is not on this order." });
    line.deleteOne();
    tab.total = tab.computeTotal();
    await tab.save();
    res.json(tabJSON(tab));
  } catch (e) { next(e); }
});

/**
 * POST /api/facilities/:facilityId/tabs/:tabId/settle
 *
 * Either  { settlement, bookingId?, paymentMethod? }      — one bill, one way
 * or      { parts: [{ settlement, amount, ... }, ...] }   — a split bill
 *
 * Closes the table, takes the money and returns everything the receipt needs.
 *
 * A split is four friends at one table where two pay cash and two sign it to
 * their rooms. Each part becomes its own Charge, which is the only way the
 * front desk can later answer a question about any one of those four people —
 * a single charge for the table would put all of it on whichever room was
 * named. The parts have to add up to the bill exactly: a table that settles
 * for less than it ordered is money walking out of the building, and one that
 * settles for more is a guest overcharged.
 */
router.post("/:facilityId/tabs/:tabId/settle", requireModule("pos"), requireAssignedFacility(), requireOperational("facility"), async (req, res, next) => {
  try {
    const facility = req.facility;
    const tab = await Tab.findOne({ _id: req.params.tabId, facility: facility._id });
    if (!tab) return res.status(404).json({ error: "That table order does not exist." });
    if (tab.status !== "open") return res.status(409).json({ error: "That table has already been settled." });
    if (!tab.lines.length) return res.status(400).json({ error: "Nothing has been ordered on this table yet." });

    const total = tab.computeTotal();
    const items = tab.lines.length + " item" + (tab.lines.length === 1 ? "" : "s");

    // One shape from here down: a plain settlement is a split of one.
    const asked = Array.isArray(req.body.parts) && req.body.parts.length
      ? req.body.parts
      : [{
          settlement: req.body.settlement,
          bookingId: req.body.bookingId,
          paymentMethod: req.body.paymentMethod,
          amount: total,
        }];

    if (asked.length > 8) {
      return res.status(400).json({ error: "A bill can be split at most eight ways." });
    }
    for (const p of asked) {
      if (!Number.isFinite(Number(p.amount)) || Number(p.amount) < 1) {
        return res.status(400).json({ error: "Every part of a split needs an amount of at least 1 naira." });
      }
    }
    const sum = asked.reduce((a, p) => a + Math.round(Number(p.amount)), 0);
    if (sum !== total) {
      return res.status(400).json({
        error: "The split comes to " + sum + " naira but the bill is " + total +
          ". Adjust the parts so they add up exactly.",
      });
    }

    const receiptNo = "R" + Date.now().toString(36).toUpperCase().slice(-6);
    const parts = [];
    const charges = [];

    for (let i = 0; i < asked.length; i++) {
      const p = asked[i];
      const label = asked.length > 1
        ? tab.tableName + " — part " + (i + 1) + " of " + asked.length
        : tab.tableName + " — " + items;

      const result = await settleFacilitySale({
        facility,
        settlement: p.settlement,
        bookingId: p.bookingId,
        paymentMethod: p.paymentMethod,
        amount: Math.round(Number(p.amount)),
        description: label,
        userId: req.user.id,
      });

      if (!result.ok) {
        // Any part failing leaves the whole bill unsettled. Undoing the parts
        // already taken is the only honest thing to do — half a settled table
        // is a bill nobody can reconcile, and the guest is still standing
        // there to be asked again.
        await unwindParts(parts, "Split settlement failed partway: " + result.error);
        return res.status(result.status).json({
          error: result.error + (parts.length ? " Nothing was taken; try the whole bill again." : ""),
        });
      }

      // The surname is looked up per part, not taken from the tab: a split
      // across two rooms has two guests, and putting one of their names
      // against both halves is exactly the confusion a split is meant to end.
      if (result.booking) await result.booking.populate("guest", "name");

      charges.push(result.charge._id);
      parts.push({
        settlement: p.settlement,
        amount: Math.round(Number(p.amount)),
        paymentMethod: p.settlement === "paid" ? p.paymentMethod : undefined,
        booking: result.booking ? result.booking._id : undefined,
        roomNumber: result.booking ? result.booking.roomNumber : undefined,
        guestSurname: result.booking ? surnameOfBooking(result.booking) : undefined,
        charge: result.charge._id,
        payment: result.payment ? result.payment._id : undefined,
      });
    }

    const roomPart = parts.find((p) => p.settlement === "room");

    tab.status = "settled";
    // The single-settlement fields keep meaning what they always meant for an
    // unsplit bill, so everything written before splits existed still reads
    // correctly. A split sets them from its room part, if it has one.
    tab.settlement = parts.length === 1 ? parts[0].settlement : (roomPart ? "room" : "paid");
    tab.booking = roomPart ? roomPart.booking : undefined;
    tab.charge = charges[0];
    tab.charges = charges;
    tab.parts = parts;
    tab.total = total;
    tab.receiptNo = receiptNo;
    tab.settledBy = req.user.id;
    tab.settledAt = new Date();
    await tab.save();
    await tab.populate("openedBy settledBy", "name");

    logAction(req, {
      action: (req.isOverride ? "OVERRIDE — " : "") +
        "Settled " + tab.tableName + " at " + facility.name + " for " + total + " naira" +
        (parts.length > 1
          ? " split " + parts.length + " ways"
          : roomPart ? " to room " + roomPart.roomNumber : " paid at the till") +
        (req.isOverride ? " (" + req.body.overrideReason + ")" : ""),
      entity: "Tab", entityId: tab._id, location: facility.location, after: tab.toObject(),
    });
    req.app.get("io")?.to("loc:" + facility.location).emit("charge:posted", {
      facility: facility.name, amount: total, settlement: tab.settlement,
      bookingId: roomPart ? String(roomPart.booking) : null,
    });

    res.json({ ...tabJSON(tab), receipt: receiptFor(tab, facility, req.user.name) });
  } catch (e) { next(e); }
});

/**
 * POST /api/facilities/:facilityId/tabs/:tabId/discard  { reason? }
 *
 * Closing a table that should never have been open: a name typed wrong, a
 * party that walked out before ordering, a second tab opened for a group that
 * already had one. Until now the only ways out of an open table were to settle
 * it — which takes money for drinks nobody had — or to leave it open all night
 * cluttering the list.
 *
 * Open tables only. A settled one has money against it and is undone by voiding
 * instead, which reverses the charge rather than deleting the record of it.
 *
 * Whoever works the till may do this, and not because it is trivial: they can
 * already empty a table line by line and leave it at zero, so demanding a
 * manager for the last step would stop nothing and only teach people the
 * workaround. What it does instead is leave a trace — a discarded table is
 * logged with who discarded it, what was on it and what it was worth, which is
 * more than removing the lines one at a time has ever recorded. A table with
 * anything on it has to say why.
 */
router.post("/:facilityId/tabs/:tabId/discard", requireModule("pos"), requireAssignedFacility(), requireOperational("facility"), async (req, res, next) => {
  try {
    const tab = await Tab.findOne({ _id: req.params.tabId, facility: req.facility._id });
    if (!tab) return res.status(404).json({ error: "That table order does not exist." });
    if (tab.status === "settled") {
      return res.status(409).json({
        error: "That order has been settled, so money has changed hands. A manager can void it instead.",
      });
    }

    const worth = tab.computeTotal();
    const reason = clean(req.body?.reason, 240);
    if (tab.lines.length && reason.length < 4) {
      return res.status(400).json({
        error: "Say why a table with " + tab.lines.length + " item" +
          (tab.lines.length === 1 ? "" : "s") + " on it is being discarded — it goes in the activity log.",
      });
    }

    const before = tab.toObject();
    await tab.deleteOne();

    logAction(req, {
      action: (req.isOverride ? "OVERRIDE — " : "") +
        "Discarded the unsettled table " + before.tableName + " at " + req.facility.name +
        (before.lines.length
          ? " with " + before.lines.length + " item" + (before.lines.length === 1 ? "" : "s") +
            " worth " + worth + " naira — " + reason
          : ", which had nothing on it") +
        (req.isOverride ? " (" + req.body.overrideReason + ")" : ""),
      entity: "Tab", entityId: before._id, location: req.facility.location, before,
    });
    req.app.get("io")?.to("loc:" + req.facility.location).emit("tab:discarded", {
      facility: req.facility.name, tableName: before.tableName,
    });

    res.json({ ok: true, tableName: before.tableName, items: before.lines.length, worth });
  } catch (e) { next(e); }
});

/**
 * POST /api/facilities/:facilityId/tabs/:tabId/void  { reason }
 *
 * Undoing a bill after the money was taken. A manager's decision, never the
 * bartender's own — the person who took the money must not be able to make it
 * disappear, which is the whole reason charges are voided rather than deleted.
 *
 * The tab and its lines are left exactly as they were. What was ordered really
 * was ordered; what is being undone is the money. Every charge and payment the
 * tab produced is voided with the same reason, so the guest's folio, the till
 * and the month's figures all stop counting it at the same moment.
 */
router.post("/:facilityId/tabs/:tabId/void", requireRole("manager", "owner"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const tab = await Tab.findOne({ _id: req.params.tabId, facility: req.facility._id });
    if (!tab) return res.status(404).json({ error: "That table order does not exist." });
    if (tab.voided) return res.status(409).json({ error: "That order has already been voided." });
    if (tab.status !== "settled") {
      return res.status(409).json({
        error: "That order has not been settled, so there is no payment to undo. Remove its items instead.",
      });
    }

    const reason = clean(req.body.reason, 240);
    if (reason.length < 4) {
      return res.status(400).json({ error: "Say why this is being voided — it goes in the activity log." });
    }

    const voided = await unwindParts(tab.parts, reason);

    tab.voided = true;
    tab.voidReason = reason;
    tab.voidedBy = req.user.id;
    tab.voidedAt = new Date();
    await tab.save();
    await tab.populate("openedBy settledBy voidedBy", "name");

    logAction(req, {
      action: "Voided settled order " + tab.tableName + " at " + req.facility.name +
        " for " + tab.total + " naira — " + reason,
      entity: "Tab", entityId: tab._id, location: req.facility.location,
      before: { voided: false, total: tab.total }, after: tab.toObject(),
    });
    req.app.get("io")?.to("loc:" + req.facility.location).emit("charge:voided", {
      facility: req.facility.name, amount: tab.total,
    });

    res.json({ ...tabJSON(tab), voidedCharges: voided.charges, voidedPayments: voided.payments });
  } catch (e) { next(e); }
});

/**
 * Voids the charges and payments a set of settled parts produced.
 *
 * Used both by the manager's void and by the settle route when one part of a
 * split fails after earlier parts have already gone through. Voiding rather
 * than deleting is the point: the activity log and the guest's folio history
 * both have to stay truthful about what happened.
 */
async function unwindParts(parts, reason) {
  const chargeIds = (parts || []).map((p) => p.charge).filter(Boolean);
  const paymentIds = (parts || []).map((p) => p.payment).filter(Boolean);

  const [charges, payments] = await Promise.all([
    chargeIds.length
      ? Charge.updateMany({ _id: { $in: chargeIds }, voided: false }, { voided: true, voidReason: reason })
      : { modifiedCount: 0 },
    paymentIds.length
      ? Payment.updateMany({ _id: { $in: paymentIds }, voided: false }, { voided: true, voidReason: reason })
      : { modifiedCount: 0 },
  ]);

  return { charges: charges.modifiedCount || 0, payments: payments.modifiedCount || 0 };
}

const surnameOfBooking = (b) => {
  const name = b.guest && b.guest.name ? b.guest.name : "";
  return String(name).trim().split(/\s+/).pop() || undefined;
};

/** Everything the printed or shared receipt needs, from the settled tab. */
function receiptFor(tab, facility, servedByName) {
  return {
    receiptNo: tab.receiptNo,
    facility: facility.name,
    location: facility.location,
    tableName: tab.tableName,
    guestName: tab.guestName || null,
    lines: tab.lines.map((l) => ({
      name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.unitPrice * l.qty,
    })),
    total: tab.total,
    settlement: tab.settlement,
    roomNumber: tab.roomNumber || (tab.parts || []).find((p) => p.roomNumber)?.roomNumber || null,
    // One line per way the bill was settled, so a split receipt says so
    // instead of looking like a single payment that does not match.
    parts: (tab.parts || []).map((p) => ({
      settlement: p.settlement, amount: p.amount,
      paymentMethod: p.paymentMethod || null, roomNumber: p.roomNumber || null,
      guestSurname: p.guestSurname || null,
    })),
    servedBy: servedByName,
    settledAt: tab.settledAt,
  };
}


/* ------------------------------------------------------------------ */
/*  SALES — what this facility took, for the manager                   */
/* ------------------------------------------------------------------ */

/**
 * GET /api/facilities/:facilityId/sales?from=&to=
 *
 * One facility's takings over a stretch of days, split by how the money was
 * settled and by who took it.
 *
 * Separate from the hotel-wide record on Records, and answering a different
 * question. That page is the business's month; this is the bar's week — what
 * sold, how it was paid for, and which of four people behind the counter took
 * it. A manager asking "is the Tuesday night crowd worth staying open for"
 * cannot get there from a monthly total.
 *
 * Voided orders are excluded everywhere. A voided sale is one that did not
 * happen, and it should not flatter anybody's shift.
 */
router.get("/:facilityId/sales", requireRole("manager", "owner"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const to = isDate(req.query.to) ? req.query.to : today();
    const from = isDate(req.query.from) ? req.query.from : shiftDays(to, -6);
    if (from > to) return res.status(400).json({ error: "The start date is after the end date." });

    const start = dayStart(from);
    // Exclusive end on the day after, or everything sold on the last day of
    // the range is silently left out.
    const end = dayEnd(to);

    const tabs = await Tab.find({
      facility: req.facility._id, status: "settled", voided: { $ne: true },
      settledAt: { $gte: start, $lt: end },
    }).populate("settledBy", "name").sort({ settledAt: 1 }).lean();

    const byDay = {};
    const byMethod = {};
    const byStaff = {};
    const itemCounts = {};
    let total = 0;
    let chargedToRooms = 0;
    let paidAtTill = 0;

    tabs.forEach((t) => {
      const day = dayOf(t.settledAt);
      const d = (byDay[day] = byDay[day] || { date: day, total: 0, orders: 0, room: 0, till: 0 });
      d.total += t.total;
      d.orders += 1;
      total += t.total;

      // A split bill counts once per part, under each way it was actually
      // settled. Counting the whole table under one method is how "cash"
      // ends up including money that arrived on a room.
      partsOf(t).forEach((p) => {
        const key = methodKey(p);
        byMethod[key] = (byMethod[key] || 0) + p.amount;
        if (p.settlement === "room") { chargedToRooms += p.amount; d.room += p.amount; }
        else { paidAtTill += p.amount; d.till += p.amount; }
      });

      const who = t.settledBy && t.settledBy.name ? t.settledBy.name : "Unknown";
      const st = (byStaff[who] = byStaff[who] || { name: who, total: 0, orders: 0 });
      st.total += t.total;
      st.orders += 1;

      (t.lines || []).forEach((l) => {
        const it = (itemCounts[l.name] = itemCounts[l.name] || { name: l.name, qty: 0, revenue: 0 });
        it.qty += l.qty;
        it.revenue += l.unitPrice * l.qty;
      });
    });

    // Every day in the range, including the ones that sold nothing — a gap in
    // a list of dates reads as missing data, and a quiet Monday is a finding.
    const days = [];
    for (let d = from; d <= to; d = shiftDays(d, 1)) {
      days.push(byDay[d] || { date: d, total: 0, orders: 0, room: 0, till: 0 });
    }

    res.json({
      facility: { id: req.facility._id, name: req.facility.name, type: req.facility.type },
      from, to, currency: "NGN",
      orders: tabs.length,
      total, chargedToRooms, paidAtTill,
      averageOrder: tabs.length ? Math.round(total / tabs.length) : 0,
      byMethod,
      days,
      byStaff: Object.values(byStaff).sort((a, b) => b.total - a.total),
      topItems: Object.values(itemCounts).sort((a, b) => b.qty - a.qty).slice(0, 12),
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  VISITS — who is in the pool or the gym                             */
/* ------------------------------------------------------------------ */

/** GET /api/facilities/:facilityId/visits?date=YYYY-MM-DD */
router.get("/:facilityId/visits", requireModule("pos"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const date = req.query.date ? clean(req.query.date, 10) : today();
    if (!isDate(date)) return res.status(400).json({ error: "Send the date as YYYY-MM-DD." });
    const from = dayStart(date);
    const to = dayEnd(date);

    const visits = await FacilityVisit.find({
      facility: req.facility._id, createdAt: { $gte: from, $lt: to },
    }).sort({ createdAt: -1 }).lean();

    res.json({
      facility: { id: req.facility._id, name: req.facility.name, type: req.facility.type, entryFee: req.facility.entryFee || 0 },
      date,
      insideNow: visits.filter((v) => !v.leftAt).length,
      takings: visits.reduce((s, v) => s + v.amount, 0),
      visits: visits.map((v) => ({
        id: v._id, guestName: v.guestName, phone: v.phone || null, people: v.people,
        amount: v.amount, settlement: v.settlement,
        bookingId: v.booking ? String(v.booking) : null,
        enteredAt: v.createdAt, leftAt: v.leftAt || null,
      })),
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/facilities/:facilityId/visits
 * { guestName, phone?, people?, settlement, bookingId?, paymentMethod? }
 *
 * The fee comes from the facility, multiplied by how many came in. Staff do not
 * type the amount — that is what keeps the pool's takings reconcilable.
 */
router.post("/:facilityId/visits", requireModule("pos"), requireAssignedFacility(), requireOperational("facility"), async (req, res, next) => {
  try {
    const facility = req.facility;
    if (!["pool", "gym"].includes(facility.type)) {
      return res.status(400).json({ error: facility.name + " does not log visits." });
    }
    const closed = facilityClosedError(facility);
    if (closed) return res.status(closed.status).json({ error: closed.error });

    const guestName = clean(req.body.guestName, 120);
    if (guestName.length < 2) return res.status(400).json({ error: "Enter the guest's name." });
    const people = Math.max(1, Math.min(50, Number(req.body.people) || 1));

    const fee = Number(facility.entryFee || 0);
    if (fee < 1) {
      return res.status(400).json({
        error: "No entry fee is set for " + facility.name + " yet. A manager sets it on the Facilities screen.",
      });
    }
    const amount = fee * people;
    const description = facility.name + " entry — " + guestName + (people > 1 ? " (" + people + " people)" : "");

    const result = await settleFacilitySale({
      facility,
      settlement: req.body.settlement,
      bookingId: req.body.bookingId,
      paymentMethod: req.body.paymentMethod,
      amount, description,
      userId: req.user.id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    const visit = await FacilityVisit.create({
      location: facility.location, facility: facility._id,
      guestName, phone: clean(req.body.phone, 20) || undefined, people,
      booking: result.booking ? result.booking._id : undefined,
      amount, settlement: req.body.settlement, charge: result.charge._id,
      recordedBy: req.user.id,
    });

    logAction(req, {
      action: (req.isOverride ? "OVERRIDE — " : "") +
        "Logged " + guestName + " into " + facility.name + " for " + amount + " naira" +
        (req.isOverride ? " (" + req.body.overrideReason + ")" : ""),
      entity: "FacilityVisit", entityId: visit._id, location: facility.location, after: visit.toObject(),
    });
    res.status(201).json({ id: visit._id, guestName, people, amount, settlement: visit.settlement });
  } catch (e) { next(e); }
});

/** POST /api/facilities/:facilityId/visits/:visitId/leave — marks them gone. */
router.post("/:facilityId/visits/:visitId/leave", requireModule("pos"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const visit = await FacilityVisit.findOne({ _id: req.params.visitId, facility: req.facility._id });
    if (!visit) return res.status(404).json({ error: "That visit does not exist." });
    if (visit.leftAt) return res.json({ id: visit._id, leftAt: visit.leftAt });
    visit.leftAt = new Date();
    await visit.save();
    res.json({ id: visit._id, leftAt: visit.leftAt });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  GYM MEMBERSHIPS                                                    */
/* ------------------------------------------------------------------ */

/** GET /api/facilities/:facilityId/plans */
router.get("/:facilityId/plans", requireModule("pos"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const plans = await MembershipPlan.find({ facility: req.facility._id, active: true })
      .sort({ days: 1 }).lean();
    res.json(plans.map((p) => ({ id: p._id, name: p.name, days: p.days, price: p.price })));
  } catch (e) { next(e); }
});

/** POST /api/facilities/:facilityId/plans  { name, days, price } — manager and owner. */
router.post("/:facilityId/plans", requireRole("manager", "owner"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const facility = req.facility;
    if (facility.type !== "gym") {
      return res.status(400).json({ error: "Only a gym has membership plans." });
    }
    const name = clean(req.body.name, 60);
    const days = Number(req.body.days);
    const price = Number(req.body.price);
    if (name.length < 2) return res.status(400).json({ error: "Name the plan." });
    if (!Number.isFinite(days) || days < 1) return res.status(400).json({ error: "Say how many days the plan runs for." });
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Enter the plan's price." });

    const plan = await MembershipPlan.create({
      location: facility.location, facility: facility._id,
      name, days, price, updatedBy: req.user.id,
    });
    logAction(req, {
      action: "Added gym plan " + name + " (" + days + " days, " + price + " naira)",
      entity: "MembershipPlan", entityId: plan._id, location: facility.location, after: plan.toObject(),
    });
    res.status(201).json({ id: plan._id, name, days, price });
  } catch (e) { next(e); }
});

/** PATCH /api/facilities/:facilityId/plans/:planId  { name?, days?, price?, active? } */
router.patch("/:facilityId/plans/:planId", requireRole("manager", "owner"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const plan = await MembershipPlan.findOne({ _id: req.params.planId, facility: req.facility._id });
    if (!plan) return res.status(404).json({ error: "That plan does not exist here." });
    const before = plan.toObject();

    if (req.body.name !== undefined) {
      const name = clean(req.body.name, 60);
      if (name.length < 2) return res.status(400).json({ error: "Name the plan." });
      plan.name = name;
    }
    if (req.body.days !== undefined) {
      const days = Number(req.body.days);
      if (!Number.isFinite(days) || days < 1) return res.status(400).json({ error: "Say how many days the plan runs for." });
      plan.days = days;
    }
    if (req.body.price !== undefined) {
      const price = Number(req.body.price);
      if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Enter the plan's price." });
      plan.price = price;
    }
    if (typeof req.body.active === "boolean") plan.active = req.body.active;
    plan.updatedBy = req.user.id;
    await plan.save();

    logAction(req, {
      action: "Updated gym plan " + plan.name,
      entity: "MembershipPlan", entityId: plan._id, location: req.facility.location,
      before, after: plan.toObject(),
    });
    res.json({ id: plan._id, name: plan.name, days: plan.days, price: plan.price, active: plan.active });
  } catch (e) { next(e); }
});

/** GET /api/facilities/:facilityId/memberships — current members first, then lapsed. */
router.get("/:facilityId/memberships", requireModule("pos"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const now = today();
    const rows = await Membership.find({ facility: req.facility._id })
      .sort({ endsOn: -1 }).limit(300).lean();

    res.json(rows.map((m) => ({
      id: m._id, memberName: m.memberName, phone: m.phone || null,
      planName: m.planName, price: m.price,
      startsOn: m.startsOn, endsOn: m.endsOn,
      // Computed here rather than stored: a stored "active" flag is wrong the
      // morning after it expires, and nothing runs overnight to correct it.
      current: m.endsOn >= now && m.startsOn <= now,
      expired: m.endsOn < now,
      settlement: m.settlement,
    })));
  } catch (e) { next(e); }
});

/**
 * POST /api/facilities/:facilityId/memberships
 * { memberName, phone?, planId, startsOn?, settlement, bookingId?, paymentMethod? }
 *
 * A renewal is a new term, not an edit of the old one — see models/Membership.js.
 */
router.post("/:facilityId/memberships", requireModule("pos"), requireAssignedFacility(), requireOperational("facility"), async (req, res, next) => {
  try {
    const facility = req.facility;
    if (facility.type !== "gym") {
      return res.status(400).json({ error: "Only a gym takes memberships." });
    }
    const closed = facilityClosedError(facility);
    if (closed) return res.status(closed.status).json({ error: closed.error });

    const memberName = clean(req.body.memberName, 120);
    if (memberName.length < 2) return res.status(400).json({ error: "Enter the member's name." });

    const plan = await MembershipPlan.findOne({ _id: req.body.planId, facility: facility._id, active: true });
    if (!plan) return res.status(404).json({ error: "Choose one of this gym's plans." });

    const startsOn = isDate(req.body.startsOn) ? req.body.startsOn : today();
    const endsOn = shiftDays(startsOn, plan.days);
    const description = facility.name + " " + plan.name + " membership — " + memberName;

    const result = await settleFacilitySale({
      facility,
      settlement: req.body.settlement,
      bookingId: req.body.bookingId,
      paymentMethod: req.body.paymentMethod,
      amount: plan.price, description,
      userId: req.user.id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    const membership = await Membership.create({
      location: facility.location, facility: facility._id,
      memberName, phone: clean(req.body.phone, 20) || undefined,
      plan: plan._id, planName: plan.name, price: plan.price,
      startsOn, endsOn,
      settlement: req.body.settlement,
      booking: result.booking ? result.booking._id : undefined,
      charge: result.charge._id,
      recordedBy: req.user.id,
    });

    logAction(req, {
      action: (req.isOverride ? "OVERRIDE — " : "") +
        "Signed up " + memberName + " to " + plan.name + " at " + facility.name +
        " (" + startsOn + " to " + endsOn + ")" +
        (req.isOverride ? " (" + req.body.overrideReason + ")" : ""),
      entity: "Membership", entityId: membership._id, location: facility.location,
      after: membership.toObject(),
    });
    res.status(201).json({
      id: membership._id, memberName, planName: plan.name, price: plan.price, startsOn, endsOn,
    });
  } catch (e) { next(e); }
});

module.exports = router;
