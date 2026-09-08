const router = require("express").Router();
const SiteContent = require("../models/SiteContent");
const FaqEntry = require("../models/FaqEntry");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logAction } = require("../services/audit");

// Publishing to the public website is a manager decision.
router.use(requireAuth, requireRole("manager", "owner"));

/**
 * A call to action is a link staff type that a stranger's browser will follow.
 * Relative paths and https only — `javascript:` and `data:` URLs are the same
 * cross-site-scripting problem wearing a different hat.
 */
function badHref(href) {
  if (!href) return null;
  const v = String(href).trim();
  if (v.startsWith("/") && !v.startsWith("//")) return null;
  if (/^https:\/\/[^\s]+$/i.test(v)) return null;
  return "Links must be a path starting with / or a full https:// address.";
}

/** Same rule as a link — relative or https only, whatever the resource is. */
function badMediaUrl(url) {
  return badHref(url) ? "Media must be a path starting with / or a full https:// address." : null;
}

const FIELDS = ["key","type","location","title","body","mediaType","mediaUrl","caption","ctaLabel","ctaHref","active","startsAt","endsAt","priority"];
const pick = (body) => FIELDS.reduce((o, k) => (body[k] !== undefined ? { ...o, [k]: body[k] } : o), {});

/* ---------------- site content ---------------- */

router.get("/", async (req, res, next) => {
  try {
    const rows = await SiteContent.find().sort({ priority: -1, updatedAt: -1 }).lean();
    const now = new Date();
    res.json(rows.map((r) => ({
      ...r,
      // Worked out here so the editor and the website can never disagree about
      // whether something is currently showing.
      liveNow: !!(r.active
        && (!r.startsAt || new Date(r.startsAt) <= now)
        && (!r.endsAt || new Date(r.endsAt) >= now)),
      expired: !!(r.endsAt && new Date(r.endsAt) < now),
      scheduled: !!(r.startsAt && new Date(r.startsAt) > now),
    })));
  } catch (e) { next(e); }
});

router.post("/", async (req, res, next) => {
  try {
    const data = pick(req.body);
    if (!data.key || !data.title || !data.type) {
      return res.status(400).json({ error: "A key, a type and a title are required." });
    }
    const hrefError = badHref(data.ctaHref);
    if (hrefError) return res.status(400).json({ error: hrefError });
    if (data.mediaUrl) {
      const mediaError = badMediaUrl(data.mediaUrl);
      if (mediaError) return res.status(400).json({ error: mediaError });
    }
    if (data.startsAt && data.endsAt && new Date(data.endsAt) <= new Date(data.startsAt)) {
      return res.status(400).json({ error: "The end date has to be after the start date." });
    }

    const doc = await SiteContent.create({ ...data, updatedBy: req.user.id });
    logAction(req, {
      action: "Created website content \"" + doc.title + "\"" + (doc.active ? " and published it" : " as a draft"),
      entity: "SiteContent", entityId: doc._id, location: doc.location,
    });
    res.status(201).json(doc);
  } catch (e) { next(e); }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const data = pick(req.body);
    const hrefError = badHref(data.ctaHref);
    if (hrefError) return res.status(400).json({ error: hrefError });
    if (data.mediaUrl) {
      const mediaError = badMediaUrl(data.mediaUrl);
      if (mediaError) return res.status(400).json({ error: mediaError });
    }

    const before = await SiteContent.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ error: "That content does not exist." });

    const doc = await SiteContent.findByIdAndUpdate(
      req.params.id, { ...data, updatedBy: req.user.id }, { new: true, runValidators: true }
    );
    logAction(req, {
      action: "Updated website content \"" + doc.title + "\"",
      entity: "SiteContent", entityId: doc._id, location: doc.location,
      before: { active: before.active, title: before.title },
      after: { active: doc.active, title: doc.title },
    });
    res.json(doc);
  } catch (e) { next(e); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const doc = await SiteContent.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: "That content does not exist." });
    logAction(req, {
      action: "Deleted website content \"" + doc.title + "\"",
      entity: "SiteContent", entityId: doc._id, location: doc.location,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------------- FAQ entries ---------------- */

router.get("/faq/all", async (_req, res, next) => {
  try {
    res.json(await FaqEntry.find().sort({ category: 1, order: 1 }).lean());
  } catch (e) { next(e); }
});

router.post("/faq", async (req, res, next) => {
  try {
    const { question, answer, category, location, active, order } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ error: "A question and an answer are both required." });
    }
    const doc = await FaqEntry.create({
      question, answer, category, location, active, order, updatedBy: req.user.id,
    });
    logAction(req, { action: "Added the FAQ answer \"" + doc.question + "\"", entity: "FaqEntry", entityId: doc._id });
    res.status(201).json(doc);
  } catch (e) { next(e); }
});

router.patch("/faq/:id", async (req, res, next) => {
  try {
    const allowed = ["question", "answer", "category", "location", "active", "order"];
    const update = allowed.reduce((o, k) => (req.body[k] !== undefined ? { ...o, [k]: req.body[k] } : o), {});
    const doc = await FaqEntry.findByIdAndUpdate(
      req.params.id, { ...update, updatedBy: req.user.id }, { new: true, runValidators: true }
    );
    if (!doc) return res.status(404).json({ error: "That FAQ answer does not exist." });
    logAction(req, { action: "Updated the FAQ answer \"" + doc.question + "\"", entity: "FaqEntry", entityId: doc._id });
    res.json(doc);
  } catch (e) { next(e); }
});

router.delete("/faq/:id", async (req, res, next) => {
  try {
    const doc = await FaqEntry.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: "That FAQ answer does not exist." });
    logAction(req, { action: "Deleted the FAQ answer \"" + doc.question + "\"", entity: "FaqEntry", entityId: doc._id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
