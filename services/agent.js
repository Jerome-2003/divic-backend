
const Booking = require("../models/Booking");
const Guest = require("../models/Guest");
const Room = require("../models/Room");
const Facility = require("../models/Facility");
const User = require("../models/User");
const Payment = require("../models/Payment");
const Charge = require("../models/Charge");
const FaqEntry = require("../models/FaqEntry");
const SiteContent = require("../models/SiteContent");
const BookingRequest = require("../models/BookingRequest");
const AuditLog = require("../models/AuditLog");
const Rate = require("../models/Rate");
const { buildContext } = require("./aiContext");
const { ask } = require("./gemini");
const { isRoomAvailable } = require("./availability");
const { folioFor, foliosFor } = require("./folio");
const { LOCATIONS } = require("../utils/constants");

const ALL_PROPS = ["exclusive", "urban"];
const STAFF_ROLES = ["receptionist", "cleaner", "manager", "facility", "owner"];

const cleanText = (v) => String(v || "").trim();
const lower = (v) => cleanText(v).toLowerCase();
const money = (n) => "₦" + Number(n || 0).toLocaleString("en-NG");

function propertyLabel(location) {
  return LOCATIONS[location]?.name || location;
}


async function webRequestSearch(ref, user) {
  if (!canSee("booking", user)) return { handled: true, text: "Your role does not have access to booking requests." };
  const request = await BookingRequest.findOne({ reference: new RegExp("^" + ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }).lean();
  if (!request) return { handled: true, text: `I could not find website request ${ref}.` };
  if (user.location !== "all" && request.location !== user.location) {
    return { handled: true, text: "That website request belongs to the other property." };
  }
  return {
    handled: true,
    text: [
      `${request.reference} — ${propertyLabel(request.location)}`,
      `Guest: ${request.guestName}`,
      `Room type: ${request.roomType}`,
      `Stay: ${request.checkIn} to ${request.checkOut} — ${request.nights} night(s)`,
      `Status: ${request.status}`,
      `Quoted total: ${money(request.quotedTotal)}`,
      request.payment?.required ? `Payment: ${request.payment.verified ? "verified" : "not verified"}` : "Payment not required.",
      request.booking ? `Booking created: ${String(request.booking)}` : "",
      request.declineReason ? `Decline reason: ${request.declineReason}` : "",
    ].filter(Boolean).join("\n"),
  };
}

async function paymentSearch(ref, user) {
  if (!canSee("financial", user)) return { handled: true, text: "Your role does not have access to payment records." };
  const payment = await Payment.findOne({
    $or: [
      { paystackReference: new RegExp("^" + ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") },
      ...(require("mongoose").Types.ObjectId.isValid(ref) ? [{ _id: ref }] : []),
    ],
  }).populate("facility", "name").lean();
  if (!payment) return { handled: true, text: `I could not find payment ${ref}.` };
  if (user.location !== "all" && payment.location !== user.location) {
    return { handled: true, text: "That payment belongs to the other property." };
  }
  return {
    handled: true,
    text: [
      `Payment: ${payment.paystackReference || String(payment._id)}`,
      `Property: ${propertyLabel(payment.location)}`,
      `Amount: ${money(payment.amount)}${payment.netAmount != null ? ` — net ${money(payment.netAmount)}` : ""}`,
      `Method: ${payment.method}`,
      `Status: ${payment.voided ? "VOIDED" : payment.verified ? "VERIFIED" : "recorded"}`,
      payment.facility ? `Facility: ${payment.facility.name}` : "",
      payment.booking ? `Booking: ${String(payment.booking)}` : "",
      payment.note ? `Note: ${payment.note}` : "",
      `Recorded: ${new Date(payment.createdAt).toISOString()}`,
    ].filter(Boolean).join("\n"),
  };
}

async function facilitySalesSearch(term, user) {
  if (!canSee("financial", user)) return { handled: true, text: "Only managers, owners and receptionists can access sales figures." };
  const needle = lower(term);
  const locs = roleLocations(user);
  const facilities = await Facility.find({
    location: { $in: locs },
    $or: [{ name: new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }, { slug: new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }],
  }).lean();

  if (!facilities.length) return { handled: true, text: `I could not find a facility matching "${term}".` };
  const since = new Date();
  since.setUTCHours(0,0,0,0);
  const rows = await Charge.aggregate([
    { $match: { facility: { $in: facilities.map(f => f._id) }, voided: false, createdAt: { $gte: since } } },
    { $group: { _id: "$facility", total: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);
  const by = Object.fromEntries(rows.map(r => [String(r._id), r]));
  return {
    handled: true,
    text: facilities.map(f => `${propertyLabel(f.location)} — ${f.name}: ${money(by[String(f._id)]?.total || 0)} today (${by[String(f._id)]?.count || 0} charge(s))`).join("\n"),
  };
}

async function ratesSearch(type, user) {
  if (!canSee("room", user)) return { handled: true, text: "Your role does not have access to room rates." };
  const locs = roleLocations(user);
  const rooms = await Room.find({ location: { $in: locs } }).select("type").lean();
  const rateDocs = await Rate.find({ location: { $in: locs } }).lean();
  const roomTypes = [...new Set(rooms.map(r => r.type))];
  const lines = [];
  for (const loc of locs) {
    const doc = rateDocs.find(r => r.location === loc);
    const prices = doc?.prices instanceof Map ? Object.fromEntries(doc.prices) : (doc?.prices || {});
    const types = lower(type) ? roomTypes.filter(x => x.toLowerCase().includes(lower(type))) : roomTypes;
    lines.push(`${propertyLabel(loc)} — ${types.map(t => `${t}: ${money(prices[t])} per night`).join(", ")}`);
  }
  return { handled: true, text: lines.join("\n") };
}

async function notificationSearch(user) {
  if (!canSee("public", user)) return { handled: true, text: "Your role does not have access to notifications through the assistant." };
  const Notification = require("../models/Notification");
  const locs = roleLocations(user);
  const rows = await Notification.find({ location: { $in: locs } }).sort({ createdAt: -1 }).limit(15).lean();
  if (!rows.length) return { handled: true, text: "There are no recent notifications." };
  return { handled: true, text: rows.map(n => `${propertyLabel(n.location)} — ${n.urgent ? "URGENT — " : ""}${n.title}: ${n.body || ""}`).join("\n") };
}

async function auditSearch(term, user) {
  if (!canSee("audit", user)) return { handled: true, text: "Only managers and owners can access the audit trail." };
  const needle = cleanText(term);
  const filter = needle ? { action: new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") } : {};
  const rows = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(20).lean();
  if (!rows.length) return { handled: true, text: "No matching audit entries were found." };
  return { handled: true, text: rows.map(a => `${new Date(a.createdAt).toISOString()} — ${a.action}`).join("\n") };
}

function fallbackHelp() {
  return [
    "I could not identify exactly what you are looking for.",
    "",
    "Try one of these:",
    "GUEST - NAME: ___",
    "BOOKING - REF: DX-____",
    "ROOM - NUMBER: ___",
    "ROOM TYPE - NAME: ___",
    "FACILITY - NAME: ___",
    "STAFF - NAME: ___",
    "ANALYTICS - TOPIC: ___",
    "AVAILABILITY - ROOM TYPE: ___ - CHECK-IN: YYYY-MM-DD - CHECK-OUT: YYYY-MM-DD",
  ].join("\n");
}

function canSee(category, user) {
  const role = user.role;
  if (role === "owner" || role === "manager") return true;

  const map = {
    guest: ["receptionist"],
    booking: ["receptionist"],
    financial: ["receptionist"],
    room: ["receptionist", "cleaner"],
    facility: ["receptionist"],
    staff: [],
    analytics: [],
    public: ["receptionist", "cleaner"],
    audit: [],
  };

  if (role === "facility") {
    return category === "facility";
  }
  return (map[category] || []).includes(role);
}

async function locationFromRoom(number, preferred) {
  const q = { number: String(number) };
  if (preferred) {
    const one = await Room.findOne({ ...q, location: preferred }).lean();
    if (one) return one.location;
  }
  const rows = await Room.find(q).select("location").lean();
  return rows.length === 1 ? rows[0].location : null;
}

function roleLocations(user, requested) {
  if (user.location === "all") {
    return requested && ALL_PROPS.includes(requested) ? [requested] : ALL_PROPS;
  }
  return [user.location];
}

async function guestSearch(term, user) {
  if (!canSee("guest", user)) return { handled: true, text: "Your role does not have access to guest records." };

  const needle = cleanText(term);
  if (!needle) return { handled: true, text: "Use GUEST - NAME: ___." };

  const rx = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const guests = await Guest.find({ $or: [{ name: rx }, { phone: rx }, { email: rx }] })
    .sort({ name: 1 }).limit(10).lean();

  if (!guests.length) return { handled: true, text: `I could not find a guest matching "${needle}".` };

  const stays = await Booking.find({ guest: { $in: guests.map(g => g._id) }, status: { $ne: "cancelled" } })
    .sort({ checkIn: -1 }).limit(100).lean();
  const byGuest = {};
  for (const b of stays) (byGuest[String(b.guest)] ||= []).push(b);

  const lines = [];
  for (const g of guests) {
    const gs = byGuest[String(g._id)] || [];
    lines.push(
      `${g.name} — ${g.phone}${g.email ? ` — ${g.email}` : ""}${g.blacklisted ? " — BLACKLISTED" : ""}`,
      `  Stays: ${gs.length}.`,
      ...gs.slice(0, 5).map(b =>
        `  ${b.ref} — ${propertyLabel(b.location)} — room ${b.roomNumber || "unassigned"} — ${b.roomType} — ${b.checkIn} to ${b.checkOut} — ${b.status} — ${money(b.totalCharge)}`
      ),
      ""
    );
  }

  return { handled: true, text: lines.join("\n").trim(), data: { guests } };
}

async function bookingSearch(ref, user) {
  if (!canSee("booking", user)) return { handled: true, text: "Your role does not have access to booking records." };
  const booking = await Booking.findOne({ ref: new RegExp("^" + ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") })
    .populate("guest", "name phone email").lean();
  if (!booking) return { handled: true, text: `I could not find booking ${ref}.` };

  if (user.location !== "all" && booking.location !== user.location) {
    return { handled: true, text: "That booking belongs to the other property." };
  }

  const folio = await folioFor(booking);
  const text = [
    `${booking.ref}`,
    `Guest: ${booking.guest?.name || "Unknown"}${booking.guest?.phone ? ` — ${booking.guest.phone}` : ""}`,
    `Property: ${propertyLabel(booking.location)}`,
    `Room: ${booking.roomNumber || "unassigned"} (${booking.roomType})`,
    `Stay: ${booking.checkIn} to ${booking.checkOut} — ${booking.nights} night(s)`,
    `Status: ${booking.status}`,
    `Room charge: ${money(booking.totalCharge)}`,
    `Additional facility charges: ${money(folio.facilityCharges)}`,
    `Paid: ${money(folio.paid)}`,
    `Balance: ${money(folio.balance)}`,
    booking.specialRequests ? `Special request: ${booking.specialRequests}` : "",
    booking.needsAttention ? `ATTENTION: ${booking.attentionReason || "This booking needs attention."}` : "",
  ].filter(Boolean).join("\n");
  return { handled: true, text, data: { booking, folio } };
}

async function roomSearch(number, user) {
  if (!canSee("room", user)) return { handled: true, text: "Your role does not have access to room records." };
  const n = cleanText(number);
  const locs = roleLocations(user);
  const rooms = await Room.find({ number: n, location: { $in: locs } }).sort({ location: 1 }).lean();
  if (!rooms.length) return { handled: true, text: `I could not find room ${n} in your accessible properties.` };

  const lines = [];
  for (const r of rooms) {
    const current = await Booking.findOne({
      location: r.location,
      roomNumber: r.number,
      status: { $in: ["confirmed", "in-house"] },
    }).populate("guest", "name").sort({ checkIn: 1 }).lean();

    lines.push(
      `${propertyLabel(r.location)} — Room ${r.number}`,
      `Type: ${r.type}`,
      `Floor: ${r.floor}`,
      `Status: ${r.status}${r.statusNote ? ` — ${r.statusNote}` : ""}`,
      current ? `Booking: ${current.ref} — ${current.guest?.name || "guest"} — ${current.checkIn} to ${current.checkOut} — ${current.status}` : "No current booking.",
      ""
    );
  }
  return { handled: true, text: lines.join("\n").trim() };
}

async function roomTypeSearch(type, user) {
  if (!canSee("room", user)) return { handled: true, text: "Your role does not have access to room records." };
  const wanted = lower(type);
  const locs = roleLocations(user);

  if (!wanted) {
    const rooms = await Room.find({ location: { $in: locs } }).sort({ location: 1, type: 1, number: 1 }).lean();
    const grouped = {};
    for (const r of rooms) {
      const key = `${r.location}::${r.type}`;
      (grouped[key] ||= []).push(r);
    }
    const lines = [];
    for (const [key, rs] of Object.entries(grouped)) {
      const [loc, roomType] = key.split("::");
      const counts = rs.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
      lines.push(`${propertyLabel(loc)} — ${roomType}: ${rs.length} rooms — ${Object.entries(counts).map(([k,v]) => `${k} ${v}`).join(", ")}`);
    }
    return { handled: true, text: lines.join("\n") || "No rooms were found." };
  }

  const filter = {
    location: { $in: locs },
    type: new RegExp("^" + wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i"),
  };
  const rooms = await Room.find(filter).sort({ location: 1, number: 1 }).lean();
  if (!rooms.length) return { handled: true, text: `I could not find a room type called "${type}".` };

  const rateDocs = await Rate.find({ location: { $in: locs } }).lean();
  const rateBy = Object.fromEntries(rateDocs.map(r => [r.location, Number(r.prices?.get?.(type) ?? r.prices?.[type]) || null]));
  const by = {};
  for (const r of rooms) (by[r.location] ||= []).push(r);
  const lines = [];
  for (const [loc, rs] of Object.entries(by)) {
    const counts = rs.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
    lines.push(
      `${propertyLabel(loc)} — ${type}`,
      `Rooms: ${rs.map(r => r.number).join(", ")}`,
      `Status: ${Object.entries(counts).map(([k,v]) => `${k} ${v}`).join(", ")}`,
      rateBy[loc] ? `Current rate: ${money(rateBy[loc])} per night` : "",
      ""
    );
  }
  return { handled: true, text: lines.filter(Boolean).join("\n").trim() };
}

async function facilitySearch(term, user) {
  if (!canSee("facility", user)) return { handled: true, text: "Your role does not have access to facility records." };
  const needle = lower(term);
  const locs = roleLocations(user);
  let facilities = await Facility.find({
    location: { $in: locs },
    $or: [
      { name: new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
      { slug: new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
      { type: new RegExp("^" + needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") },
    ],
  }).sort({ location: 1, name: 1 }).lean();

  if (user.role === "facility") {
    facilities = facilities.filter(f => (user.assignedFacilities || []).includes(String(f._id)));
  }
  if (!facilities.length) return { handled: true, text: `I could not find a facility matching "${term}".` };

  const lines = facilities.map(f =>
    `${propertyLabel(f.location)} — ${f.name}: ${f.status}${f.statusNote ? ` — ${f.statusNote}` : ""}. Hours: ${f.openingHours || "not set"}. ${f.sellsItems ? "Sells items." : "No sales."}`
  );
  return { handled: true, text: lines.join("\n") };
}

async function staffSearch(term, user) {
  if (!canSee("staff", user)) return { handled: true, text: "Only managers and owners can access staff records." };
  const needle = cleanText(term);
  const rx = needle ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
  const filter = rx ? { $or: [{ name: rx }, { username: rx }, { role: rx }] } : {};
  const users = await User.find(filter).sort({ name: 1 }).limit(50).lean();
  if (!users.length) return { handled: true, text: `I could not find a staff member matching "${term}".` };

  const facilityIds = [...new Set(users.flatMap(u => (u.assignedFacilities || []).map(String)))];
  const facilities = await Facility.find({ _id: { $in: facilityIds } }).select("name location").lean();
  const fBy = Object.fromEntries(facilities.map(f => [String(f._id), f]));

  return {
    handled: true,
    text: users.map(u => {
      const assigned = (u.assignedFacilities || []).map(id => fBy[String(id)]?.name).filter(Boolean);
      return `${u.name} — ${u.role} — ${u.location}${u.phone ? ` — ${u.phone}` : ""}${u.active ? "" : " — INACTIVE"}${assigned.length ? ` — Facilities: ${assigned.join(", ")}` : ""}`;
    }).join("\n"),
  };
}

async function availabilitySearch(args, user) {
  if (!canSee("room", user)) return { handled: true, text: "Your role does not have access to room availability." };
  const loc = args.location || (user.location === "all" ? null : user.location);
  const locs = loc ? [loc] : roleLocations(user);
  const checkIn = args.checkIn;
  const checkOut = args.checkOut;
  const roomType = args.roomType;
  if (!checkIn || !checkOut) return { handled: true, text: "Use AVAILABILITY - ROOM TYPE: ___ - CHECK-IN: YYYY-MM-DD - CHECK-OUT: YYYY-MM-DD." };

  const lines = [];
  for (const location of locs) {
    const free = await require("../services/availability").findAvailableRooms(location, checkIn, checkOut, roomType ? { roomType } : {});
    lines.push(`${propertyLabel(location)}: ${free.length ? free.map(r => `${r.number} (${r.type})`).join(", ") : "No rooms available"}`);
  }
  return { handled: true, text: lines.join("\n") };
}

async function analyticsSearch(topic, user) {
  if (!canSee("analytics", user)) return { handled: true, text: "Only managers and owners can access analytics." };
  const t = lower(topic);

  if (/compare|both properties|two properties|exclusive.*urban|urban.*exclusive/.test(t)) {
    const ctx = await buildContext("propertyComparison", null);
    const p = ctx.properties || {};
    return {
      handled: true,
      text: ALL_PROPS.map(loc => {
        const x = p[loc] || {};
        return `${propertyLabel(loc)}: occupancy ${x.occupancyPercent ?? 0}%, ADR ${money(x.averageDailyRate)}, room revenue ${money(x.totalRoomRevenue)}, total revenue ${money(x.totalRevenue)}.`;
      }).join("\n"),
    };
  }

  if (/source|where.*book|channel/.test(t)) {
    const ctx = await buildContext("bookingSources", user.location === "all" ? "exclusive" : user.location);
    return {
      handled: true,
      text: `${ctx.property}, last 90 days: ` +
        (ctx.sources || []).map(s => `${s.source}: ${s.bookings} booking(s), ${s.sharePercent}% share, ${money(s.revenue)} revenue`).join(" | "),
    };
  }

  if (/repeat|regular|loyal/.test(t)) {
    const ctx = await buildContext("repeatGuests", null);
    return {
      handled: true,
      text: (ctx.guests || []).slice(0, 10).map(g =>
        `${g.name}: ${g.stays} stays, ${g.nights} nights, ${money(g.spend)} spend${g.stayedAtBothProperties ? ", both properties" : ""}.`
      ).join("\n") || "No repeat guests were found.",
    };
  }

  if (/price|rate|pricing/.test(t)) {
    const ctx = await buildContext("pricingSignals", user.location === "all" ? "exclusive" : user.location);
    return {
      handled: true,
      text: Object.entries(ctx.byRoomType || {}).map(([type, s]) =>
        `${type}: ${money(s.currentRate)} rate, ${s.occupancyPercent}% occupancy (${s.nightsSold}/${s.nightsPossible} nights).`
      ).join("\n"),
    };
  }

  if (/occupancy|full|busy|empty|forecast|outlook|next\s+\d+/.test(t)) {
    const ctx = await buildContext("forwardOccupancy", user.location === "all" ? "exclusive" : user.location);
    return {
      handled: true,
      text: `${ctx.property}: ${ctx.sellableRooms} sellable rooms. ` +
        (ctx.nights || []).map(n => `${n.date} ${n.occupancyPercent}% (${n.roomsSold})`).join(" | "),
    };
  }

  if (/today|sales today|collected/.test(t)) {
    // operationsSnapshot is intentionally used here because it also exposes
    // unpaid balances and rooms not ready, which are actionable daily figures.
    const ctx = await buildContext("operationsSnapshot", user.location === "all" ? "exclusive" : user.location);
    return {
      handled: true,
      text: [
        `${ctx.property} today: occupancy ${ctx.occupancyPercent}%.`,
        `Arrivals: ${(ctx.arrivingToday || []).length}. Departures: ${(ctx.departingToday || []).length}.`,
        `Departures with unpaid balance: ${(ctx.departingWithBalance || []).length}.`,
        `Rooms not ready: ${(ctx.notReadyToSell || []).length}.`,
      ].join("\n"),
    };
  }

  const ctx = await buildContext("revenueSummary", user.location === "all" ? "exclusive" : user.location);
  const byType = Object.entries(ctx.byRoomType || {})
    .map(([type, x]) => `${type}: ${x.bookings || 0} booking(s), ${x.nights || 0} nights, ${money(x.revenue)} revenue`)
    .join("\n");

  return {
    handled: true,
    text: [
      `${ctx.property}, last 30 days:`,
      `Occupancy: ${ctx.occupancyPercent}%. ADR: ${money(ctx.averageDailyRate)}. RevPAR: ${money(ctx.revPAR)}.`,
      `Room revenue: ${money(ctx.totalRoomRevenue)}. Facility revenue: ${money(ctx.facilityRevenue?.total)}. Total revenue: ${money(ctx.totalRevenue)}.`,
      byType ? `By room type:\n${byType}` : "",
    ].filter(Boolean).join("\n"),
  };
}

async function publicSearch(term, user) {
  if (!canSee("public", user)) return { handled: true, text: "Your role does not have access to published content." };
  const needle = cleanText(term);
  const rx = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const [faqs, content] = await Promise.all([
    FaqEntry.find({ active: true, $or: [{ question: rx }, { answer: rx }], location: { $in: ["both", user.location] } }).limit(10).lean(),
    SiteContent.find({ active: true, $or: [{ title: rx }, { body: rx }], location: { $in: ["both", user.location] } }).limit(10).lean(),
  ]);
  if (!faqs.length && !content.length) return { handled: true, text: `I could not find published information matching "${term}".` };
  return {
    handled: true,
    text: [
      ...faqs.map(f => `${f.question}\n${f.answer}`),
      ...content.map(c => `${c.title}\n${c.body || ""}`),
    ].join("\n\n"),
  };
}

function extractAfter(label, question) {
  const m = question.match(new RegExp(label + "\\s*[:=-]\\s*(.+)$", "i"));
  return m ? m[1].trim() : null;
}

function inferDirect(question) {
  const q = cleanText(question);
  let m;

  m = q.match(/\b((?:DX|DU)-\d{4,8})\b/i);
  if (m) return { type: "booking", ref: m[1].toUpperCase() };

  m = q.match(/\b(WEB-[A-Z0-9]+)\b/i);
  if (m) return { type: "webRequest", ref: m[1].toUpperCase() };

  m = q.match(/\b(?:PAY|PAYMENT)?[-:\s]*([A-Z0-9_-]{6,30})\b/i);
  if (/\bpaystack\b|\bpayment\s+(?:ref|reference)\b/i.test(q) && m) return { type: "payment", ref: m[1] };

  m = q.match(/\bguest\s*[-:]\s*(.+)$/i);
  if (m) return { type: "guest", term: m[1].trim() };

  m = q.match(/\b(?:guest|customer)\s+(?:named|called)\s+(.+)/i);
  if (m) return { type: "guest", term: m[1].trim().replace(/[?.]+$/, "") };

  m = q.match(/\broom\s*[-:#]?\s*(\d{3,4})\b/i);
  if (m) return { type: "room", number: m[1] };

  m = q.match(/\broom\s*type\s*[-:]\s*(.+)$/i);
  if (m) return { type: "roomType", typeName: m[1].trim() };

  m = q.match(/\bfacility\s*[-:]\s*(.+)$/i);
  if (m) return { type: "facility", term: m[1].trim() };

  m = q.match(/\bstaff\s*[-:]\s*(.+)$/i);
  if (m) return { type: "staff", term: m[1].trim() };

  m = q.match(/\brate(?:s|ing)?\s*[-:]\s*(.+)$/i);
  if (m) return { type: "rates", typeName: m[1].trim() };

  if (/\bnotifications?\b|\balerts?\b|\bwhat.*attention\b/i.test(q)) return { type: "notifications" };
  if (/\baudit\b|\bwho changed\b|\bactivity log\b/i.test(q)) return { type: "audit", term: q };

  m = q.match(/\b(?:availability|available)\b.*?room\s*type\s*[:=-]\s*([a-z0-9 -]+)/i);
  if (m) return { type: "availability", roomType: m[1].trim() };

  return null;
}

async function searchByName(question, user) {
  // Name-first lookup: if the user simply types "John Doe", treat it as a
  // guest lookup for roles allowed to see guests. This is intentionally
  // conservative for managers/owners only when there is a strong match.
  if (!canSee("guest", user)) return null;
  const term = cleanText(question).replace(/[?.]+$/, "");
  if (term.length < 3 || term.split(/\s+/).length < 2) return null;
  const rx = new RegExp("^" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");
  const count = await Guest.countDocuments({ name: rx });
  return count ? { type: "guest", term } : null;
}

function fallbackForType(type) {
  const messages = {
    guest: "GUEST - NAME: ___",
    booking: "BOOKING - REF: DX-____",
    webRequest: "WEB REQUEST - REF: WEB-______",
    payment: "PAYMENT - REF: ______",
    room: "ROOM - NUMBER: ___",
    roomType: "ROOM TYPE - NAME: ___",
    facility: "FACILITY - NAME: ___",
    staff: "STAFF - NAME: ___",
    rates: "RATES - ROOM TYPE: ___",
    analytics: "ANALYTICS - TOPIC: ___",
    availability: "AVAILABILITY - ROOM TYPE: ___ - CHECK-IN: YYYY-MM-DD - CHECK-OUT: YYYY-MM-DD",
  };
  return messages[type] || fallbackHelp();
}

async function classifyWithGemini(question) {
  const result = await ask({
    instruction: `
Classify the user's hotel-PMS question into exactly ONE action and return ONLY JSON.
Allowed actions:
guest, booking, webRequest, payment, room, roomType, facility, facilitySales, staff, rates, availability, analytics, public, notifications, audit, help.
JSON shape:
{"type":"guest","term":"John Doe"}
{"type":"booking","ref":"DX-1234"}
{"type":"webRequest","ref":"WEB-2K4F9A"}
{"type":"payment","ref":"PAYSTACK-REF"}
{"type":"room","number":"204"}
{"type":"roomType","typeName":"deluxe"}
{"type":"facility","term":"indoor pool"}
{"type":"facilitySales","term":"restaurant"}
{"type":"staff","term":"Mary"}
{"type":"rates","typeName":"deluxe"}
{"type":"availability","roomType":"deluxe","checkIn":"YYYY-MM-DD","checkOut":"YYYY-MM-DD","location":"exclusive"}
{"type":"analytics","topic":"occupancy last 30 days"}
{"type":"notifications"}
{"type":"audit","term":"booking"}
{"type":"public","term":"check-in time"}
{"type":"help"}
Do not answer the question. Do not invent missing values. If required values are absent, leave them blank.
`,
    context: { now: new Date().toISOString(), examples: fallbackHelp() },
    userQuestion: question,
    history: [],
  });
  if (!result.ok) return null;

  const raw = result.text.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!["guest","booking","webRequest","payment","room","roomType","facility","facilitySales","staff","rates","availability","analytics","public","notifications","audit","help"].includes(parsed.type)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function runAction(action, user) {
  switch (action.type) {
    case "guest": return guestSearch(action.term, user);
    case "booking": return bookingSearch(action.ref, user);
    case "webRequest": return webRequestSearch(action.ref, user);
    case "payment": return paymentSearch(action.ref, user);
    case "room": return roomSearch(action.number, user);
    case "roomType": return roomTypeSearch(action.typeName, user);
    case "facility": return facilitySearch(action.term, user);
    case "facilitySales": return facilitySalesSearch(action.term, user);
    case "staff": return staffSearch(action.term, user);
    case "rates": return ratesSearch(action.typeName, user);
    case "notifications": return notificationSearch(user);
    case "audit": return auditSearch(action.term, user);
    case "availability": return availabilitySearch(action, user);
    case "analytics": return analyticsSearch(action.topic, user);
    case "public": return publicSearch(action.term, user);
    default: return { handled: true, text: fallbackHelp() };
  }
}


async function inferFromDatabaseTerms(question, user) {
  const q = lower(question);

  if (canSee("room", user)) {
    const locs = roleLocations(user);
    const types = await Room.distinct("type", { location: { $in: locs } });
    const type = types.find(t => q.includes(String(t).toLowerCase()));
    if (type && /\broom|rate|price|type|suite|deluxe|superior|classic|crown|standard\b/.test(q)) {
      return { type: "roomType", typeName: type };
    }
  }

  if (canSee("facility", user)) {
    const locs = roleLocations(user);
    let facilities = await Facility.find({ location: { $in: locs } }).select("name slug type _id").lean();
    if (user.role === "facility") {
      facilities = facilities.filter(f => (user.assignedFacilities || []).includes(String(f._id)));
    }
    const hit = facilities.find(f =>
      q.includes(lower(f.name)) || q.includes(lower(f.slug)) || q.includes(lower(f.type))
    );
    if (hit && /facility|pool|gym|bar|restaurant|open|closed|maintenance|hour/.test(q)) {
      return { type: "facility", term: hit.name };
    }
  }

  return null;
}

async function runAgent({ question, user }) {
  const q = cleanText(question);
  if (!q) return { ok: false, text: "Type a question or use one of the command templates.\n\n" + fallbackHelp() };
  if (q.length > 500) return { ok: false, text: "Keep the question under 500 characters." };

  let action = inferDirect(q);
  if (!action) action = await searchByName(q, user);
  if (!action) action = await inferFromDatabaseTerms(q, user);

  // Common natural-language clues that are deterministic and do not need Gemini.
  if (!action) {
    const lq = lower(q);
    if (/^(what|which|show).*(rooms?).*(available|free)/.test(lq)) action = { type: "roomType", typeName: "" };
    else if (/facility|pool|gym|bar|restaurant|opening hour|closed|maintenance/.test(lq)) action = { type: "facility", term: q };
    else if (/staff|employee|receptionist|cleaner|manager|bartender/.test(lq)) action = { type: "staff", term: q };
    else if (/occupancy|adr|revpar|revenue|sales|booking source|repeat guest|analytics|last 30|today/.test(lq)) action = { type: "analytics", topic: q };
  }

  if (!action) action = await classifyWithGemini(q);
  if (!action) return { ok: true, text: fallbackHelp(), mode: "template" };

  if (action.type === "availability" && (!action.checkIn || !action.checkOut)) {
    return { ok: true, text: fallbackForType("availability"), mode: "template" };
  }
  if (["guest","booking","room","roomType","facility","staff","public"].includes(action.type) && !cleanText(action.term || action.ref || action.number || action.typeName)) {
    return { ok: true, text: fallbackForType(action.type), mode: "template" };
  }

  const result = await runAction(action, user);
  return { ok: true, text: result.text, mode: result.mode || "database", action: action, data: result.data || null };
}

module.exports = { runAgent, fallbackHelp };
