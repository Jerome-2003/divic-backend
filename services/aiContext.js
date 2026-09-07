/**
 * Context builders.
 *
 * Every builder returns a small plain object. Nothing raw goes to Gemini —
 * no full booking documents, no guest ID numbers, no phone numbers, no staff
 * passwords. Aggregating here rather than in the prompt is what keeps token
 * use low and stops the model doing arithmetic it will get wrong.
 */

const Booking = require("../models/Booking");
const Room = require("../models/Room");
const Facility = require("../models/Facility");
const Charge = require("../models/Charge");
const Guest = require("../models/Guest");
const BookingRequest = require("../models/BookingRequest");
const Rate = require("../models/Rate");
const { LOCATIONS } = require("../utils/constants");
const { findAvailableRooms, nightsBetween } = require("./availability");
const { foliosFor } = require("./folio");

const today = () => new Date().toISOString().slice(0, 10);
const shift = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function ratesFor(location) {
  const doc = await Rate.findOne({ location }).lean();
  return doc ? Object.fromEntries(Object.entries(doc.prices)) : LOCATIONS[location].rates;
}

/* ---------------------------------------------------------------- */

async function operationsSnapshot(location) {
  const t = today();
  const [rooms, arriving, inHouse, departing] = await Promise.all([
    Room.find({ location }).lean(),
    Booking.find({ location, status: "confirmed", checkIn: { $lte: t } }).populate("guest", "name").lean(),
    Booking.find({ location, status: "in-house" }).populate("guest", "name").lean(),
    Booking.find({ location, status: "in-house", checkOut: { $lte: t } }).populate("guest", "name").lean(),
  ]);

  // Room and facility charges both count — a bar tab is a balance.
  const folios = await foliosFor(departing);

  const owing = departing
    .map((b) => {
      const f = folios[String(b._id)];
      return {
        guest: b.guest?.name, room: b.roomNumber,
        roomCharges: f.roomCharges, facilityCharges: f.facilityCharges, balance: f.balance,
      };
    })
    .filter((x) => x.balance > 0);

  const byStatus = rooms.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});

  return {
    property: LOCATIONS[location].name,
    date: t,
    totalRooms: rooms.length,
    roomsByStatus: byStatus,
    occupancyPercent: Math.round((inHouse.length / rooms.length) * 100),
    arrivingToday: arriving.map((b) => ({ guest: b.guest?.name, room: b.roomNumber, type: b.roomType, nights: b.nights })),
    departingToday: departing.map((b) => ({ guest: b.guest?.name, room: b.roomNumber })),
    departingWithBalance: owing,
    notReadyToSell: rooms.filter((r) => ["dirty", "cleaning", "maintenance"].includes(r.status))
      .map((r) => ({ room: r.number, floor: r.floor, status: r.status })),
  };
}

async function housekeepingSnapshot(location) {
  const rooms = await Room.find({ location }).sort({ floor: 1, number: 1 }).lean();
  const inHouse = await Booking.find({ location, status: "in-house" }).select("roomNumber").lean();
  const occupied = new Set(inHouse.map((b) => b.roomNumber));
  return {
    property: LOCATIONS[location].name,
    totalRooms: rooms.length,
    rooms: rooms.map((r) => ({
      room: r.number, floor: r.floor, type: r.type, status: r.status,
      occupied: occupied.has(r.number), note: r.statusNote || undefined,
    })),
    sellableNow: rooms.filter((r) => r.status === "available").length,
  };
}

async function outstandingBalances(location) {
  const open = await Booking.find({ location, status: { $in: ["confirmed", "in-house"] } })
    .populate("guest", "name").lean();
  const folios = await foliosFor(open);

  const rows = open.map((b) => {
    const f = folios[String(b._id)];
    return {
      guest: b.guest?.name, room: b.roomNumber, ref: b.ref,
      checkOut: b.checkOut,
      roomCharges: f.roomCharges,
      facilityCharges: f.facilityCharges,
      charges: f.totalCharges,
      paid: f.paid,
      balance: f.balance,
    };
  }).filter((r) => r.balance > 0).sort((a, b) => b.balance - a.balance);

  return {
    property: LOCATIONS[location].name,
    today: today(),
    currency: "NGN",
    totalOutstanding: rows.reduce((s, r) => s + r.balance, 0),
    totalFacilityCharges: rows.reduce((s, r) => s + r.facilityCharges, 0),
    note: "Charges are the room plus anything charged to the room at a bar, restaurant or pool.",
    guests: rows,
  };
}

/** Facility takings over a period. Never mixed into ADR or RevPAR. */
async function facilityRevenue(location, from) {
  const rows = await Charge.aggregate([
    { $match: { location, voided: false, createdAt: { $gte: new Date(from + "T00:00:00.000Z") } } },
    { $group: {
        _id: { facility: "$facility", settlement: "$settlement" },
        total: { $sum: "$amount" }, count: { $sum: 1 },
    } },
  ]);
  const facilities = await Facility.find({ location }).select("name type").lean();
  const nameBy = Object.fromEntries(facilities.map((f) => [String(f._id), f]));

  const byFacility = {};
  rows.forEach((r) => {
    const f = nameBy[String(r._id.facility)];
    const key = f ? f.name : "Unknown facility";
    byFacility[key] = byFacility[key] || { type: f?.type, chargedToRooms: 0, paidAtTill: 0, total: 0, charges: 0 };
    byFacility[key][r._id.settlement === "room" ? "chargedToRooms" : "paidAtTill"] += r.total;
    byFacility[key].total += r.total;
    byFacility[key].charges += r.count;
  });

  return {
    total: Object.values(byFacility).reduce((s, v) => s + v.total, 0),
    byFacility,
  };
}

async function revenueSummary(location) {
  const from = shift(today(), -30);
  const rooms = await Room.find({ location }).lean();
  const bookings = await Booking.find({
    location, status: { $ne: "cancelled" }, checkIn: { $gte: from },
  }).lean();

  const roomNights = bookings.reduce((s, b) => s + b.nights, 0);
  const revenue = bookings.reduce((s, b) => s + b.totalCharge, 0);
  const available = rooms.length * 30;

  const byType = {};
  bookings.forEach((b) => {
    byType[b.roomType] = byType[b.roomType] || { bookings: 0, nights: 0, revenue: 0 };
    byType[b.roomType].bookings += 1;
    byType[b.roomType].nights += b.nights;
    byType[b.roomType].revenue += b.totalCharge;
  });
  rooms.forEach((r) => {
    byType[r.type] = byType[r.type] || { bookings: 0, nights: 0, revenue: 0 };
    byType[r.type].roomsOfThisType = (byType[r.type].roomsOfThisType || 0) + 1;
  });

  return {
    property: LOCATIONS[location].name,
    period: { from, to: today(), days: 30 },
    currency: "NGN",
    totalRooms: rooms.length,
    roomNightsSold: roomNights,
    roomNightsAvailable: available,
    occupancyPercent: available ? Math.round((roomNights / available) * 100) : 0,
    averageDailyRate: roomNights ? Math.round(revenue / roomNights) : 0,
    revPAR: available ? Math.round(revenue / available) : 0,
    totalRoomRevenue: revenue,
    byRoomType: byType,
    // Kept separate from the room metrics on purpose. ADR and RevPAR mean
    // revenue per room night sold and per available room; folding bar takings
    // into them makes the numbers meaningless.
    facilityRevenue: await facilityRevenue(location, from),
    currentRates: await ratesFor(location),
  };
}

async function propertyComparison() {
  const out = {};
  for (const id of ["exclusive", "urban"]) out[id] = await revenueSummary(id);
  return { note: "The two properties operate separately and are not pooled.", properties: out };
}

async function pricingSignals(location) {
  const summary = await revenueSummary(location);
  const rates = await ratesFor(location);
  const signals = {};
  Object.entries(summary.byRoomType).forEach(([type, v]) => {
    const roomsOfType = v.roomsOfThisType || 0;
    const possible = roomsOfType * 30;
    signals[type] = {
      currentRate: rates[type],
      roomsOfThisType: roomsOfType,
      nightsSold: v.nights,
      nightsPossible: possible,
      occupancyPercent: possible ? Math.round((v.nights / possible) * 100) : 0,
      revenue: v.revenue,
    };
  });
  return {
    property: LOCATIONS[location].name,
    period: summary.period,
    currency: "NGN",
    byRoomType: signals,
    caveat: "Based only on this property's own booking history. No competitor or market data is available to the system.",
  };
}

async function bookingSources(location) {
  const from = shift(today(), -90);
  const rows = await Booking.aggregate([
    { $match: { location, status: { $ne: "cancelled" }, checkIn: { $gte: from } } },
    { $group: { _id: "$source", bookings: { $sum: 1 }, nights: { $sum: "$nights" }, revenue: { $sum: "$totalCharge" } } },
    { $sort: { bookings: -1 } },
  ]);
  const total = rows.reduce((s, r) => s + r.bookings, 0);
  return {
    property: LOCATIONS[location].name,
    period: { from, to: today(), days: 90 },
    currency: "NGN",
    totalBookings: total,
    sources: rows.map((r) => ({
      source: r._id, bookings: r.bookings, nights: r.nights, revenue: r.revenue,
      sharePercent: total ? Math.round((r.bookings / total) * 100) : 0,
    })),
  };
}

async function repeatGuests() {
  const rows = await Booking.aggregate([
    { $match: { status: { $ne: "cancelled" } } },
    { $group: {
        _id: "$guest",
        stays: { $sum: 1 }, nights: { $sum: "$nights" }, spend: { $sum: "$totalCharge" },
        properties: { $addToSet: "$location" }, lastStay: { $max: "$checkIn" },
    } },
    { $match: { stays: { $gt: 1 } } },
    { $sort: { stays: -1, spend: -1 } },
    { $limit: 20 },
  ]);
  const guests = await Guest.find({ _id: { $in: rows.map((r) => r._id) } }).select("name").lean();
  const nameBy = Object.fromEntries(guests.map((g) => [String(g._id), g.name]));
  return {
    currency: "NGN",
    guests: rows.map((r) => ({
      name: nameBy[String(r._id)] || "Unknown",
      stays: r.stays, nights: r.nights, spend: r.spend,
      stayedAtBothProperties: r.properties.length > 1,
      lastStay: r.lastStay,
    })),
  };
}

async function pendingRequests(location) {
  const reqs = await BookingRequest.find({ location, status: "pending" }).sort({ createdAt: 1 }).lean();
  const enriched = [];
  for (const r of reqs) {
    const free = await findAvailableRooms(location, r.checkIn, r.checkOut, { roomType: r.roomType });
    enriched.push({
      reference: r.reference, guest: r.guestName, roomType: r.roomType,
      checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights,
      quotedTotal: r.quotedTotal,
      roomsFreeOfThatType: free.length,
      canAcceptNow: free.length > 0,
      requestedAt: r.createdAt,
    });
  }
  return { property: LOCATIONS[location].name, today: today(), currency: "NGN", pending: enriched };
}

async function forwardOccupancy(location) {
  const t = today();
  const roomCount = await Room.countDocuments({ location, status: { $ne: "maintenance" } });
  const bookings = await Booking.find({
    location, status: { $in: ["confirmed", "in-house"] }, checkOut: { $gt: t },
  }).select("checkIn checkOut").lean();

  const nights = Array.from({ length: 14 }, (_, i) => {
    const d = shift(t, i);
    const sold = bookings.filter((b) => b.checkIn <= d && b.checkOut > d).length;
    return { date: d, roomsSold: sold, occupancyPercent: roomCount ? Math.round((sold / roomCount) * 100) : 0 };
  });

  return { property: LOCATIONS[location].name, sellableRooms: roomCount, nights };
}

const BUILDERS = {
  operationsSnapshot, housekeepingSnapshot, outstandingBalances, revenueSummary,
  propertyComparison, pricingSignals, bookingSources, repeatGuests,
  pendingRequests, forwardOccupancy,
};

async function buildContext(name, location) {
  if (!name || name === "none") return null;
  const fn = BUILDERS[name];
  if (!fn) throw new Error("Unknown context builder: " + name);
  return fn(location);
}

module.exports = { buildContext, BUILDERS };
