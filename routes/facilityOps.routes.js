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

const clean = (s, max = 200) => String(s || "").trim().slice(0, max);
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

/** "2026-09-13" + 30 days -> "2026-10-13" */
function addDays(isoDate, days) {
  const d = new Date(isoDate + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

const itemJSON = (i) => ({
  id: i._id, name: i.name, category: i.category, price: i.price, active: i.active,
});

const tabJSON = (t) => ({
  id: t._id,
  tableName: t.tableName,
  guestName: t.guestName || null,
  status: t.status,
  lines: (t.lines || []).map((l) => ({
    id: l._id, name: l.name, unitPrice: l.unitPrice, qty: l.qty,
    lineTotal: l.unitPrice * l.qty,
  })),
  total: (t.lines || []).reduce((s, l) => s + l.unitPrice * l.qty, 0),
  settlement: t.settlement || null,
  bookingId: t.booking ? String(t.booking) : null,
  receiptNo: t.receiptNo || null,
  settledAt: t.settledAt || null,
  openedAt: t.createdAt,
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
 * Manager and owner only. What a facility charges is a pricing decision, the
 * same as room rates — a bartender sells from the list, they do not write it.
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

/** PATCH /api/facilities/:facilityId/menu/:itemId  { name?, price?, category?, active? } */
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

/** GET /api/facilities/:facilityId/tabs?status=open */
router.get("/:facilityId/tabs", requireModule("pos"), requireAssignedFacility(), async (req, res, next) => {
  try {
    const status = req.query.status === "settled" ? "settled" : "open";
    const filter = { facility: req.facility._id, status };
    // A settled tab is history; only today's is worth loading by default.
    if (status === "settled") {
      const from = new Date(today() + "T00:00:00.000Z");
      filter.settledAt = { $gte: from };
    }
    const tabs = await Tab.find(filter).sort({ updatedAt: -1 }).limit(100).lean();
    res.json(tabs.map(tabJSON));
  } catch (e) { next(e); }
});

/** POST /api/facilities/:facilityId/tabs  { tableName, guestName? } — opens a table. */
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

    const tab = await Tab.create({
      location: facility.location, facility: facility._id,
      tableName, guestName: clean(req.body.guestName, 120) || undefined,
      openedBy: req.user.id,
    });
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
 * { settlement, bookingId?, paymentMethod? }
 *
 * Closes the table, takes the money and returns everything the receipt needs.
 */
router.post("/:facilityId/tabs/:tabId/settle", requireModule("pos"), requireAssignedFacility(), requireOperational("facility"), async (req, res, next) => {
  try {
    const facility = req.facility;
    const tab = await Tab.findOne({ _id: req.params.tabId, facility: facility._id });
    if (!tab) return res.status(404).json({ error: "That table order does not exist." });
    if (tab.status !== "open") return res.status(409).json({ error: "That table has already been settled." });
    if (!tab.lines.length) return res.status(400).json({ error: "Nothing has been ordered on this table yet." });

    const total = tab.computeTotal();
    const description = tab.tableName + " — " + tab.lines.length + " item" + (tab.lines.length === 1 ? "" : "s");

    const result = await settleFacilitySale({
      facility,
      settlement: req.body.settlement,
      bookingId: req.body.bookingId,
      paymentMethod: req.body.paymentMethod,
      amount: total,
      description,
      userId: req.user.id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    tab.status = "settled";
    tab.settlement = req.body.settlement;
    tab.booking = result.booking ? result.booking._id : undefined;
    tab.charge = result.charge._id;
    tab.total = total;
    tab.receiptNo = "R" + Date.now().toString(36).toUpperCase().slice(-6);
    tab.settledBy = req.user.id;
    tab.settledAt = new Date();
    await tab.save();

    logAction(req, {
      action: (req.isOverride ? "OVERRIDE — " : "") +
        "Settled " + tab.tableName + " at " + facility.name + " for " + total + " naira" +
        (result.booking ? " to room " + result.booking.roomNumber : " paid at the till") +
        (req.isOverride ? " (" + req.body.overrideReason + ")" : ""),
      entity: "Tab", entityId: tab._id, location: facility.location, after: tab.toObject(),
    });
    req.app.get("io")?.to("loc:" + facility.location).emit("charge:posted", {
      facility: facility.name, amount: total, settlement: tab.settlement,
      bookingId: result.booking ? String(result.booking._id) : null,
    });

    res.json({
      ...tabJSON(tab),
      receipt: {
        receiptNo: tab.receiptNo,
        facility: facility.name,
        location: facility.location,
        tableName: tab.tableName,
        guestName: tab.guestName || null,
        lines: tab.lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.unitPrice * l.qty })),
        total,
        settlement: tab.settlement,
        roomNumber: result.booking ? result.booking.roomNumber : null,
        servedBy: req.user.name,
        settledAt: tab.settledAt,
      },
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
    const from = new Date(date + "T00:00:00.000Z");
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);

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
    const endsOn = addDays(startsOn, plan.days);
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
