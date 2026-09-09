
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
const { promptById } = require("./aiPrompts");

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
    "You can type normal questions. The common hotel questions below are answered directly from the PMS without Gemini:",
    "",
    "Daily running",
    "What needs my attention today?",
    "Who is arriving today?",
    "Who is checking out today?",
    "Who is currently staying here?",
    "How full are we today?",
    "Which rooms aren't ready to sell?",
    "What website requests are waiting?",
    "How full are the next two weeks?",
    "What bookings are coming up?",
    "What alerts need attention?",
    "Who are the no-shows?",
    "What bookings were cancelled?",
    "",
    "Money",
    "Who still owes money?",
    "How did the last 30 days go?",
    "How much did we make today?",
    "How were we paid today?",
    "How much did each facility make?",
    "What payments came in recently?",
    "How much are payment fees costing us?",
    "How do the two properties compare?",
    "Are my rates right?",
    "",
    "Guests",
    "Where are bookings coming from?",
    "Who are my regulars?",
    "How many guests do we have?",
    "Are any guests blacklisted?",
    "",
    "Rooms",
    "How many rooms do we have?",
    "Which rooms are available now?",
    "What is the room status breakdown?",
    "Which rooms are dirty?",
    "Which rooms are being cleaned?",
    "Which rooms are under maintenance?",
    "Which rooms are occupied?",
    "What are our current room rates?",
    "What room types are available for a stay?",
    "",
    "Facilities",
    "Which facilities are open?",
    "How much did the facilities sell today?",
    "What charges were posted at a facility today?",
    "",
    "Website",
    "What is the status of website requests?",
    "What is currently published on the website?",
    "What information can the hotel FAQ answer?",
    "",
    "Staff and audit",
    "Who is on the staff?",
    "How many staff do we have by role?",
    "What changed recently?",
    "",
    "Learning",
    "Explain a hotel term",
    "",
    "Exact commands",
    "GUEST - NAME: ___",
    "BOOKING - REF: DX-____",
    "WEB REQUEST - REF: WEB-______",
    "PAYMENT - REF: ______",
    "ROOM - NUMBER: ___",
    "ROOM TYPE - NAME: ___",
    "FACILITY - NAME: ___",
    "STAFF - NAME: ___",
    "RATES - ROOM TYPE: ___",
    "ANALYTICS - TOPIC: ___",
    "AVAILABILITY - ROOM TYPE: ___ - CHECK-IN: YYYY-MM-DD - CHECK-OUT: YYYY-MM-DD",
    "",
    "You can also type a booking reference, room number or a guest's full name by itself.",
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
  const lq = lower(q);
  let m;

  if (/upcoming bookings?|bookings? coming up|next few days.*bookings?/i.test(q)) return { type: "prepared", promptId: "upcoming_bookings" };
  if (/dirty rooms?|rooms?.*dirty/i.test(q)) return { type: "prepared", promptId: "dirty_rooms" };
  if (/cleaning rooms?|rooms?.*being cleaned/i.test(q)) return { type: "prepared", promptId: "cleaning_rooms" };
  if (/maintenance rooms?|rooms?.*under maintenance|out of order rooms?/i.test(q)) return { type: "prepared", promptId: "maintenance_rooms" };
  if (/occupied rooms?/i.test(q) && !/occupancy/i.test(q)) return { type: "prepared", promptId: "occupied_rooms" };
  if (/^(?:who|which).*arriv.*today|today.*arrivals?/i.test(q)) return { type: "prepared", promptId: "arrivals_today" };
  if (/(?:who|which).*check.*out.*today|today.*departures?/i.test(q)) return { type: "prepared", promptId: "departures_today" };
  if (/(?:who|which).*currently.*(?:staying|in[- ]house)|in[- ]house.*guests?/i.test(q)) return { type: "prepared", promptId: "in_house_guests" };
  if (/(?:how full.*today|today.*occupancy|occupancy.*today)/i.test(q)) return { type: "prepared", promptId: "occupancy_today" };
  if (/(?:urgent|important).*alerts?|alerts?.*attention|notifications?.*attention/i.test(q)) return { type: "prepared", promptId: "urgent_notifications" };
  if (/(?:unread).*notifications?|notifications?.*unread/i.test(q)) return { type: "prepared", promptId: "unread_notifications" };
  if (/(?:no[- ]shows?|didn.?t show)/i.test(q)) return { type: "prepared", promptId: "no_shows" };
  if (/(?:cancell?ed bookings?|cancellations?)/i.test(q)) return { type: "prepared", promptId: "cancellations" };
  if (/(?:how much|what).*?(?:make|sales|sold|collected).*today|today.*(?:sales|revenue|collections?)/i.test(q)) return { type: "prepared", promptId: "sales_today" };
  if (/(?:payment|paid).*?(?:method|cash|pos|transfer).*today/i.test(q)) return { type: "prepared", promptId: "payment_methods" };
  if (/facility.*(?:make|sales|revenue|takings?).*today/i.test(q)) return { type: "prepared", promptId: "facility_sales_today" };
  if (/(?:recent|latest).*payments?|payments?.*recent/i.test(q)) return { type: "prepared", promptId: "recent_payments" };
  if (/(?:payment|paystack).*fees?|fees?.*payment/i.test(q)) return { type: "prepared", promptId: "payment_fees" };
  if (/(?:how many|number of).*guests?|guest.*count/i.test(q)) return { type: "prepared", promptId: "guest_count" };
  if (/blacklist|blacklisted/i.test(q)) return { type: "prepared", promptId: "blacklisted_guests" };
  if (/(?:how many|number of).*rooms?|room inventory|room count/i.test(q)) return { type: "prepared", promptId: "room_inventory" };
  if (/(?:available|free).*rooms?.*(?:now|today)?$/i.test(q)) return { type: "prepared", promptId: "available_rooms_now" };
  if (/(?:room status|status.*rooms?|breakdown.*rooms?)/i.test(q)) return { type: "prepared", promptId: "room_status_counts" };
  if (/(?:current|today.?s?).*rates?|(?:what are|show).*room rates?/i.test(q)) return { type: "prepared", promptId: "current_rates" };
  if (/(?:which|what).*facilit(?:y|ies).*(?:open|closed|maintenance|hours)|facility status|are.*(?:pool|gym|bar|restaurant).*open/i.test(q)) return { type: "prepared", promptId: "facility_status" };
  if (/(?:website|booking) requests?.*(?:status|how many|count)|request.*status/i.test(q)) return { type: "prepared", promptId: "request_summary" };
  if (/(?:what.*published|what.*live).*website|website.*content/i.test(q)) return { type: "prepared", promptId: "published_content" };
  if (/(?:faq|frequently asked).*?(?:available|answer|questions?)/i.test(q)) return { type: "prepared", promptId: "faq_knowledge" };
  if (/(?:who|what).*staff|employees?|team members?/i.test(q)) return { type: "prepared", promptId: "staff_overview" };
  if (/(?:how many).*staff|staff.*(?:by role|breakdown)/i.test(q)) return { type: "prepared", promptId: "staff_by_role" };
  if (/(?:what changed|recent changes|recent activity|audit)/i.test(q)) return { type: "prepared", promptId: "audit_recent" };

  if (/^what needs (my )?attention today\??$/i.test(q) || /what.*needs.*attention.*today/i.test(q)) return { type: "prepared", promptId: "today_briefing" };
  if (/^which rooms (?:are )?not ready to sell\??$/i.test(q) || /rooms?.*(?:not ready|not sellable|cannot be sold|out of service)/i.test(q)) return { type: "prepared", promptId: "rooms_not_ready" };
  if (/^what website requests are waiting\??$/i.test(q) || /pending website (?:requests|bookings?)/i.test(q)) return { type: "prepared", promptId: "pending_requests" };
  if (/^how full are the next two weeks\??$/i.test(q) || /next (?:14|two weeks).*(occupancy|full)/i.test(q)) return { type: "prepared", promptId: "occupancy_outlook" };
  if (/^who still owes money\??$/i.test(q) || /outstanding balances?|who owes/i.test(q)) return { type: "prepared", promptId: "unpaid_balances" };
  if (/^how did the last 30 days go\??$/i.test(q) || /last 30 days.*(revenue|occupancy|performance)/i.test(q)) return { type: "prepared", promptId: "revenue_review" };
  if (/^how do the two properties compare\??$/i.test(q) || /compare.*properties/i.test(q)) return { type: "prepared", promptId: "compare_properties" };
  if (/^are my rates right\??$/i.test(q) || /(pricing|rates?).*(right|good|high|low|correct)/i.test(q)) return { type: "prepared", promptId: "pricing_check" };
  if (/^where are bookings coming from\??$/i.test(q) || /booking sources?/i.test(q)) return { type: "prepared", promptId: "booking_sources" };
  if (/^who are my regulars\??$/i.test(q) || /repeat guests?/i.test(q)) return { type: "prepared", promptId: "repeat_guests" };
  if (/^explain a hotel term\??$/i.test(q) || /^(?:explain|what does) (?:the )?(?:hotel )?(?:term )?\w+/i.test(q)) return { type: "prepared", promptId: "explain_metric" };
  if (/^how can i ask the assistant\??$/i.test(q) || /assistant (?:help|commands?)/i.test(q)) return { type: "help" };

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
guest, booking, webRequest, payment, room, roomType, facility, facilitySales, staff, rates, availability, analytics, public, notifications, audit, prepared, help.
For the dashboard questions use prepared with one of these promptIds: today_briefing, rooms_not_ready, pending_requests, occupancy_outlook, unpaid_balances, revenue_review, compare_properties, pricing_check, booking_sources, repeat_guests, explain_metric.
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
{"type":"prepared","promptId":"today_briefing"} or {"type":"help"}
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
    if (!["guest","booking","webRequest","payment","room","roomType","facility","facilitySales","staff","rates","availability","analytics","public","notifications","audit","prepared","help"].includes(parsed.type)) return null;
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



const HOTEL_TERMS = {
  occupancy: "Occupancy is the percentage of sellable room nights that are occupied. Example: 10 occupied rooms out of 20 available rooms means 50% occupancy.",
  adr: "ADR means Average Daily Rate: room revenue divided by the number of room nights sold. Example: ₦400,000 from 10 sold room nights gives an ADR of ₦40,000.",
  revpar: "RevPAR means Revenue per Available Room: room revenue divided by all available room nights. Example: ₦400,000 across 20 rooms for one night gives RevPAR of ₦20,000.",
  revenue: "Revenue is money earned from the hotel's sales. In this assistant, room revenue and facility revenue are kept separate for metrics such as ADR and RevPAR.",
  folio: "A folio is the guest's running account: room charges plus things charged to the room, minus payments.",
};

function explainTerm(question) {
  const q = lower(question);
  const hit = Object.keys(HOTEL_TERMS).find(k => new RegExp(`\\b${k}\\b`, "i").test(q) || (k === "occupancy" && /how full|fullness|occupancy rate/.test(q)));
  if (hit) return HOTEL_TERMS[hit];
  return "Common hotel terms: Occupancy = how full the rooms are. ADR = average room rate actually sold. RevPAR = room revenue divided by all available room nights. Ask about a specific term such as occupancy, ADR, RevPAR or folio.";
}

async function preparedContext(promptId, user, requestedLocation) {
  const prompt = promptById(promptId);
  if (!prompt) return null;
  if (prompt.context === "none") return null;
  if (prompt.context.startsWith("roomStatusDetail:")) {
    const status = prompt.context.split(":")[1];
    const location = user.location === "all" ? (ALL_PROPS.includes(requestedLocation) ? requestedLocation : "exclusive") : user.location;
    return require("./aiContext").BUILDERS.roomStatusDetail(location, status);
  }
  const location = prompt.scope === "both"
    ? null
    : (user.location === "all" ? (ALL_PROPS.includes(requestedLocation) ? requestedLocation : "exclusive") : user.location);
  return buildContext(prompt.context, location, user.id);
}

function directPreparedAnswer(promptId, context) {
  if (!context) return null;
  const moneyShort = (n) => money(n);
  switch (promptId) {
    case "today_briefing": {
      const lines = [`${context.property} — today (${context.date})`, `Occupancy: ${context.occupancyPercent}%.`];
      if (context.arrivingToday?.length) lines.push(`Arrivals: ${context.arrivingToday.map(x => `${x.guest} (room ${x.room || "unassigned"})`).join(", ")}.`);
      else lines.push("Arrivals: none recorded.");
      if (context.departingToday?.length) lines.push(`Departures: ${context.departingToday.map(x => `${x.guest} (room ${x.room || "unassigned"})`).join(", ")}.`);
      else lines.push("Departures: none recorded.");
      if (context.departingWithBalance?.length) lines.push(`Outstanding for departing guests: ${context.departingWithBalance.map(x => `${x.guest} ${moneyShort(x.balance)}`).join(", ")}.`);
      if (context.notReadyToSell?.length) lines.push(`Not ready to sell: ${context.notReadyToSell.map(x => `${x.room} (${x.status})`).join(", ")}.`);
      else lines.push("All rooms are currently sellable.");
      return lines.join("\n");
    }
    case "rooms_not_ready": {
      const rows = context.rooms.filter(r => ["dirty","cleaning","maintenance"].includes(r.status));
      if (!rows.length) return `${context.property}: all ${context.totalRooms} rooms are currently sellable.`;
      return `${context.property} — ${rows.length} room(s) are not ready to sell:\n` + rows.map(r => `Room ${r.room} — ${r.type} — ${r.status}${r.note ? ` — ${r.note}` : ""}`).join("\n") + `\nSellable now: ${context.sellableNow} room(s).`;
    }
    case "pending_requests": {
      if (!context.pending.length) return `${context.property}: no website booking requests are waiting.`;
      return `${context.property} — pending website requests:\n` + context.pending.slice(0, 20).map(r => `${r.reference} — ${r.guest} — ${r.roomType} — ${r.checkIn} to ${r.checkOut} — ${r.canAcceptNow ? `${r.roomsFreeOfThatType} room(s) free` : "NO ROOM FREE"}`).join("\n");
    }
    case "occupancy_outlook": {
      const ns = context.nights || [];
      if (!ns.length) return `${context.property}: no 14-day occupancy data is available.`;
      return `${context.property} — next 14 nights:\n` + ns.map(n => `${n.date}: ${n.occupancyPercent}% (${n.roomsSold}/${context.sellableRooms})`).join("\n");
    }
    case "unpaid_balances": {
      if (!context.guests.length) return `${context.property}: nobody currently has an outstanding balance.`;
      return `${context.property} — total outstanding: ${moneyShort(context.totalOutstanding)}\n` + context.guests.slice(0, 20).map(g => `${g.guest} — room ${g.room || "unassigned"} — ${moneyShort(g.balance)} — checkout ${g.checkOut}`).join("\n");
    }
    case "revenue_review": {
      const top = Object.entries(context.byRoomType || {}).sort((a,b) => (b[1].revenue||0)-(a[1].revenue||0))[0];
      return `${context.property} — last 30 days (${context.period.from} to ${context.period.to})\nOccupancy ${context.occupancyPercent}% | ADR ${moneyShort(context.averageDailyRate)} | RevPAR ${moneyShort(context.revPAR)}\nRoom revenue ${moneyShort(context.totalRoomRevenue)} | Facility revenue ${moneyShort(context.facilityRevenue?.total)} | Total ${moneyShort(context.totalRevenue)}\nTop room-type revenue: ${top ? `${top[0]} (${moneyShort(top[1].revenue)})` : "none"}.`;
    }
    case "compare_properties": {
      const p=context.properties||{}; const a=p.exclusive,b=p.urban;
      return `Last 30 days:\n${a.property}: occupancy ${a.occupancyPercent}%, ADR ${moneyShort(a.averageDailyRate)}, room revenue ${moneyShort(a.totalRoomRevenue)}.\n${b.property}: occupancy ${b.occupancyPercent}%, ADR ${moneyShort(b.averageDailyRate)}, room revenue ${moneyShort(b.totalRoomRevenue)}.`;
    }
    case "pricing_check": {
      const rows=Object.entries(context.byRoomType||{}); if(!rows.length) return `${context.property}: there are no room-type pricing signals yet.`;
      return `${context.property} — pricing signals from the last 30 days:\n` + rows.map(([type,v]) => `${type}: ${moneyShort(v.currentRate)} | occupancy ${v.occupancyPercent}% | ${v.occupancyPercent >= 80 ? "consider testing a higher rate" : v.occupancyPercent <= 25 ? "consider testing a lower rate or promotion" : "no strong pricing signal"}`).join("\n") + `\nThese signals use only this property's own booking history.`;
    }
    case "booking_sources": {
      if (!context.sources.length) return `${context.property}: no bookings were recorded in the last 90 days.`;
      return `${context.property} — booking sources, last 90 days:\n` + context.sources.map(s => `${s.source}: ${s.bookings} booking(s), ${s.sharePercent}% share, ${moneyShort(s.revenue)}`).join("\n");
    }
    case "upcoming_bookings": {
      if (!context.bookings.length) return `${context.property}: no bookings start in the next 7 days.`;
      return `${context.property} — upcoming bookings:\n` + context.bookings.map(b => `${b.checkIn} — ${b.ref} — ${b.guest} — room ${b.room || "unassigned"} — ${b.type} — ${b.checkOut}`).join("\n");
    }
    case "dirty_rooms":
    case "cleaning_rooms":
    case "maintenance_rooms":
    case "occupied_rooms": {
      if (!context.rooms.length) return `${context.property}: no rooms match status ${context.status}.`;
      return `${context.property} — ${context.status} rooms (${context.count}): ` + context.rooms.map(r => `${r.number} (${r.type})`).join(", ");
    }
    case "repeat_guests": {
      if (!context.guests.length) return "No guest has more than one stay yet.";
      return `Regular guests:\n` + context.guests.slice(0, 20).map(g => `${g.name} — ${g.stays} stays, ${g.nights} nights, ${moneyShort(g.spend)}${g.stayedAtBothProperties ? " — stayed at both properties" : ""}`).join("\n");
    }
    case "arrivals_today": {
      if (!context.arrivals.length) return `${context.property}: no arrivals are scheduled for today.`;
      return `${context.property} — arrivals today:\n` + context.arrivals.map(a => `${a.ref} — ${a.guest} — room ${a.room || "unassigned"} — ${a.type} — checkout ${a.checkOut} — ${a.nights} night(s) — ${a.source}`).join("\n");
    }
    case "departures_today": {
      if (!context.departures.length) return `${context.property}: no in-house departures are scheduled for today.`;
      return `${context.property} — departures today:\n` + context.departures.map(d => `${d.ref} — ${d.guest} — room ${d.room || "unassigned"} — balance ${moneyShort(d.balance)}`).join("\n");
    }
    case "in_house_guests": {
      if (!context.guests.length) return `${context.property}: nobody is currently checked in.`;
      return `${context.property} — in-house guests:\n` + context.guests.map(g => `Room ${g.room || "unassigned"} — ${g.guest} — ${g.type} — ${g.ref} — checkout ${g.checkOut}`).join("\n");
    }
    case "occupancy_today":
      return `${context.property}: ${context.occupiedRooms}/${context.totalSellableRooms} sellable rooms occupied — ${context.occupancyPercent}% occupancy. ${context.availableSellableRooms} sellable room(s) available.`;
    case "urgent_notifications": {
      const notes = context.notifications || [];
      const urgent = notes.filter(n => n.urgent);
      if (!urgent.length) return `${context.property}: there are no urgent notifications in the recent alerts.`;
      return `${context.property} — urgent alerts:\n` + urgent.map(n => `${n.title}${n.body ? ` — ${n.body}` : ""}`).join("\n");
    }
    case "unread_notifications":
      return `${context.property}: ${context.unread} unread notification(s) for you.` + (context.notifications?.length ? `\nRecent: ${context.notifications.slice(0, 8).map(n => n.title).join("; ")}` : "");
    case "no_shows": {
      const rows = (context.rows || []).filter(r => r.status === "no-show");
      return rows.length ? `${context.property} — no-shows:\n` + rows.map(r => `${r.ref} — ${r.guest} — ${r.checkIn} — ${r.room || "unassigned"}`).join("\n") : `${context.property}: no no-shows found.`;
    }
    case "cancellations": {
      const rows = (context.rows || []).filter(r => r.status === "cancelled");
      return rows.length ? `${context.property} — cancelled bookings:\n` + rows.map(r => `${r.ref} — ${r.guest} — ${r.checkIn} to ${r.checkOut}${r.cancelReason ? ` — ${r.cancelReason}` : ""}`).join("\n") : `${context.property}: no cancellations found today.`;
    }
    case "sales_today":
      return `${context.property} — today: room sales ${moneyShort(context.roomSalesToday)}, facility sales ${moneyShort(context.facilitySalesToday)}, total ${moneyShort(context.totalSalesToday)} from ${context.paymentsCollectedToday} payment(s).`;
    case "payment_methods":
      return `${context.property} — today's payments by method: ` + Object.entries(context.byMethod || {}).map(([m,v]) => `${m} ${moneyShort(v)}`).join(", ");
    case "facility_revenue":
      return `${context.property} — facility revenue, last 30 days:\n` + Object.entries(context.byFacility || {}).map(([name,v]) => `${name}: ${moneyShort(v.total)} (${v.charges} charge(s))`).join("\n");
    case "facility_sales_today":
    case "facility_charges_today":
      return `${context.property} — facility sales today:\n` + context.byFacility.map(f => `${f.name}: ${moneyShort(f.revenue)} — room ${moneyShort(f.chargedToRooms)}, till ${moneyShort(f.paidAtTill)}, ${f.charges} charge(s)`).join("\n");
    case "recent_payments":
      return context.payments.length ? `${context.property} — recent payments:\n` + context.payments.map(p => `${p.reference} — ${moneyShort(p.amount)} — ${p.method} — ${p.verified ? "verified" : "recorded"}${p.voided ? " — VOIDED" : ""}${p.facility ? ` — ${p.facility}` : ""}`).join("\n") : `${context.property}: no payments found.`;
    case "payment_fees":
      return `${context.property} — last 30 days: ${moneyShort(context.totalFees)} in payment fees. Gross ${moneyShort(context.gross)}, net ${moneyShort(context.net)}.`;
    case "guest_count":
      return `${context.property}: ${context.totalGuestRecords} guest records in the database; ${context.currentInHouseGuests} guest(s) currently in house.`;
    case "blacklisted_guests":
      return context.blacklisted.length ? `${context.property} — blacklisted guests:\n${context.blacklisted.join("\n")}` : `${context.property}: no blacklisted guests are recorded.`;
    case "room_inventory":
    case "room_status_counts":
      return `${context.property}: ${context.totalRooms} rooms. By status: ` + Object.entries(context.byStatus).map(([s,c]) => `${s} ${c}`).join(", ") + ". By type: " + Object.entries(context.byType).map(([t,v]) => `${t} ${v.total}`).join(", ") + ".";
    case "available_rooms_now":
      return context.count ? `${context.property} — available now (${context.count}): ` + context.rooms.map(r => `${r.number} (${r.type})`).join(", ") : `${context.property}: no rooms are currently marked available.`;
    case "current_rates":
      return `${context.property} — current nightly rates:\n` + Object.entries(context.rates).map(([t,v]) => `${t}: ${moneyShort(v)}`).join("\n");
    case "facility_status":
      return `${context.property} — facilities:\n` + context.facilities.map(f => `${f.name}: ${f.status}${f.statusNote ? ` — ${f.statusNote}` : ""}${f.openingHours ? ` — ${f.openingHours}` : ""}`).join("\n");
    case "request_summary":
      return `${context.property}: ${context.total} website request(s). ` + Object.entries(context.counts).map(([s,c]) => `${s} ${c}`).join(", ");
    case "published_content":
      return context.content.length ? `${context.property} — live website content:\n` + context.content.map(c => `${c.type}: ${c.title}${c.body ? ` — ${c.body}` : ""}`).join("\n") : `${context.property}: no website content is currently live.`;
    case "faq_knowledge":
      return `${context.property}: ${context.total} active FAQ answers across ${Object.keys(context.categories).length} categories.\n` + Object.entries(context.categories).map(([c,qs]) => `${c}: ${qs.slice(0,4).join(" | ")}`).join("\n");
    case "staff_overview":
      return context.staff.length ? `Staff:\n` + context.staff.map(u => `${u.name} — ${u.role} — ${u.location} — ${u.active ? "active" : "inactive"}`).join("\n") : "No staff records found.";
    case "staff_by_role": {
      const grouped = {};
      context.staff.forEach(u => { const k = `${u.location} / ${u.role}`; grouped[k] = grouped[k] || {active:0,inactive:0}; grouped[k][u.active ? "active" : "inactive"]++; });
      return `Staff counts:\n` + Object.entries(grouped).map(([k,v]) => `${k}: ${v.active} active, ${v.inactive} inactive`).join("\n");
    }
    case "audit_recent":
      return context.entries.length ? `Recent audit actions:\n` + context.entries.map(e => `${new Date(e.at).toLocaleString("en-NG")} — ${e.userName || "System"} — ${e.action}`).join("\n") : "No audit entries found.";
    default: return null;
  }
}

async function runPreparedPrompt(promptId, question, user, history = [], requestedLocation = null) {
  const prompt = promptById(promptId);
  if (!prompt) return { ok: false, text: "That assistant question is not configured." };
  if (promptId === "explain_metric") return { ok: true, text: explainTerm(question || "hotel term"), mode: "template" };
  if (promptId === "command_help") return { ok: true, text: fallbackHelp(), mode: "template" };
  if (promptId === "availability_by_type") {
    const m = String(question || "").match(/(?:from|check-?in)\s*[:=-]?\s*(\d{4}-\d{2}-\d{2}).*?(?:to|check-?out)\s*[:=-]?\s*(\d{4}-\d{2}-\d{2})/i);
    const type = (String(question || "").match(/(?:room\s*type|type)\s*[:=-]\s*([a-z0-9 _-]+)/i) || [])[1]?.trim();
    if (!m) return { ok:true, text:fallbackForType("availability"), mode:"template" };
    const result = await availabilitySearch({ roomType:type, checkIn:m[1], checkOut:m[2], location: requestedLocation }, user);
    return { ok:true, text:result.text, mode:"database", data:result.data || null };
  }
  const ctx = await preparedContext(promptId, user, requestedLocation);
  const direct = directPreparedAnswer(promptId, ctx);
  if (!direct) return { ok:false, text:"That prepared question is not supported by the database yet." };
  return { ok:true, text:direct, mode:"database", data:ctx };
}

async function runAgent({ question, user, location }) {
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

  if (action.type === "prepared") {
    const prepared = await runPreparedPrompt(action.promptId, q, user, [], location);
    return prepared;
  }
  if (action.type === "help") return { ok: true, text: fallbackHelp(), mode: "template", action };

  if (action.type === "availability" && (!action.checkIn || !action.checkOut)) {
    return { ok: true, text: fallbackForType("availability"), mode: "template" };
  }
  if (["guest","booking","room","roomType","facility","staff","public"].includes(action.type) && !cleanText(action.term || action.ref || action.number || action.typeName)) {
    return { ok: true, text: fallbackForType(action.type), mode: "template" };
  }

  const result = await runAction(action, user);
  return { ok: true, text: result.text, mode: result.mode || "database", action: action, data: result.data || null };
}

module.exports = { runAgent, runPreparedPrompt, fallbackHelp };
