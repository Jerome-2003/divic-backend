process.env.JWT_SECRET = "t";
process.env.MONGO_URI = "mongodb://stub";
const mongoose = require("mongoose");
mongoose.connect = async () => ({});

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
};

// ---------- requireOperational, tested directly against the middleware ----------
const { requireOperational } = require("../middleware/auth");

function fakeReq(role, body) { return { user: { role }, body: body || {} }; }
function fakeRes() {
  const r = {};
  r.status = (c) => { r._status = c; return r; };
  r.json = (b) => { r._body = b; return r; };
  return r;
}

console.log("\n=== requireOperational ===");

// The operational role itself always passes, no override needed.
{
  const mw = requireOperational("receptionist");
  let nextCalled = false;
  mw(fakeReq("receptionist"), fakeRes(), () => { nextCalled = true; });
  check("receptionist passes with no override", nextCalled);
}

// Owner without override is refused, told exactly why.
{
  const mw = requireOperational("receptionist");
  const res = fakeRes();
  let nextCalled = false;
  mw(fakeReq("owner"), res, () => { nextCalled = true; });
  check("owner without override is refused", !nextCalled && res._status === 403);
  check("refusal names the operational role", res._body.error.includes("receptionist"));
  check("refusal flags requiresOverride", res._body.requiresOverride === true);
}

// Owner WITH override but no reason -> 400, not 403.
{
  const mw = requireOperational("receptionist");
  const res = fakeRes();
  let nextCalled = false;
  mw(fakeReq("owner", { override: true }), res, () => { nextCalled = true; });
  check("override without a reason is a 400", !nextCalled && res._status === 400);
}

// Owner WITH override AND reason -> passes, and is flagged for the log.
{
  const mw = requireOperational("receptionist");
  const req = fakeReq("owner", { override: true, overrideReason: "desk was empty" });
  let nextCalled = false;
  mw(req, fakeRes(), () => { nextCalled = true; });
  check("owner with override+reason passes", nextCalled);
  check("req.isOverride is set for the activity log", req.isOverride === true);
}

// Manager behaves identically to owner.
{
  const mw = requireOperational("cleaner");
  const req = fakeReq("manager", { override: true, overrideReason: "urgent" });
  let nextCalled = false;
  mw(req, fakeRes(), () => { nextCalled = true; });
  check("manager with override+reason also passes", nextCalled);
}

// A role that is neither operational nor owner/manager is refused outright,
// with no override path offered at all.
{
  const mw = requireOperational("receptionist");
  const res = fakeRes();
  let nextCalled = false;
  mw(fakeReq("cleaner", { override: true, overrideReason: "x" }), res, () => { nextCalled = true; });
  check("an unrelated role has no override path", !nextCalled && res._status === 403 && !res._body.requiresOverride);
}

// Multiple operational roles: facility passes for payments alongside receptionist.
{
  const mw = requireOperational("receptionist", "facility");
  let a = false, b = false;
  mw(fakeReq("receptionist"), fakeRes(), () => { a = true; });
  mw(fakeReq("facility"), fakeRes(), () => { b = true; });
  check("both listed operational roles pass", a && b);
}

// ---------- today's sales split logic ----------
console.log("\n=== today's-sales payment split ===");
function splitToday(payments) {
  let roomSalesToday = 0, facilitySalesToday = 0;
  const byFacility = {};
  payments.forEach((p) => {
    const net = p.netAmount != null ? p.netAmount : p.amount;
    if (p.facility) {
      facilitySalesToday += net;
      const name = p.facility.name || "Unknown facility";
      byFacility[name] = (byFacility[name] || 0) + net;
    } else {
      roomSalesToday += net;
    }
  });
  return { roomSalesToday, facilitySalesToday, byFacility, total: roomSalesToday + facilitySalesToday };
}

{
  const r = splitToday([
    { amount: 50000, netAmount: 48000 },                                 // room payment, has a fee
    { amount: 5000, facility: { name: "Bar" } },                          // till payment, no fee split recorded
    { amount: 3000, netAmount: 3000, facility: { name: "Restaurant" } },
  ]);
  check("room payments excluded from facility total", r.roomSalesToday === 48000);
  check("facility payments summed correctly", r.facilitySalesToday === 8000);
  check("uses netAmount when present, falls back to amount", r.byFacility.Bar === 5000 && r.byFacility.Restaurant === 3000);
  check("total is the sum of both", r.total === 56000);
}

// ---------- SiteContent media validation (same logic as badHref/badMediaUrl) ----------
console.log("\n=== mediaUrl validation ===");
function badHref(href) {
  if (!href) return null;
  const v = String(href).trim();
  if (v.startsWith("/") && !v.startsWith("//")) return null;
  if (/^https:\/\/[^\s]+$/i.test(v)) return null;
  return "bad";
}
check("relative path is accepted", badHref("/book") === null);
check("https link is accepted", badHref("https://youtube.com/watch?v=abc") === null);
check("protocol-relative // is rejected", badHref("//evil.com") !== null);
check("javascript: is rejected", badHref("javascript:alert(1)") !== null);
check("plain http:// is rejected", badHref("http://insecure.com") !== null);

// ---------- Cloudinary upload signatures ----------
console.log("\n=== Cloudinary upload signature ===");
{
  const { signUpload, isConfigured } = require("../services/cloudinary");

  // Unconfigured: the manager is told what is missing, not handed a broken
  // upload that fails at Cloudinary.
  delete process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.CLOUDINARY_API_KEY;
  delete process.env.CLOUDINARY_API_SECRET;
  check("reports itself unconfigured when keys are absent", isConfigured() === false);
  const missing = signUpload("image");
  check("unconfigured upload is refused as 503", missing.ok === false && missing.status === 503);
  check("...and names the variables to set", /CLOUDINARY_API_SECRET/.test(missing.error));

  process.env.CLOUDINARY_CLOUD_NAME = "divic";
  process.env.CLOUDINARY_API_KEY = "111";
  process.env.CLOUDINARY_API_SECRET = "shh";
  process.env.CLOUDINARY_FOLDER = "divic/site-content";

  const bad = signUpload("document");
  check("a media type that is not image or video is refused", bad.ok === false && bad.status === 400);

  const img = signUpload("image");
  check("image uploads go to the image endpoint", img.upload.uploadUrl === "https://api.cloudinary.com/v1_1/divic/image/upload");
  check("video uploads go to the video endpoint", signUpload("video").upload.uploadUrl.endsWith("/video/upload"));
  check("video is allowed to be larger than an image", signUpload("video").upload.maxBytes > img.upload.maxBytes);
  check("the secret is never handed to the browser", JSON.stringify(img.upload).includes("shh") === false);

  // The signature is Cloudinary's own recipe: signed params sorted, joined,
  // secret appended, SHA-1. Recomputed here independently — if the service
  // ever signs a different set of params than the browser sends, Cloudinary
  // rejects every upload, and this is what catches that before a manager does.
  const expected = require("crypto").createHash("sha1")
    .update("folder=divic/site-content&timestamp=" + img.upload.timestamp + "shh")
    .digest("hex");
  check("signature matches Cloudinary's documented recipe", img.upload.signature === expected);
}


console.log("\n" + (fail === 0 ? "ALL " + pass + " NEW CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
