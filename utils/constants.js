// Single source of truth for the two properties. The frontend imports the same
// numbers from its own copy in src/lib/constants.js — keep them in step.

const mongoose = require("mongoose");
const dns = require("dns");

// Windows can hand Node a resolver from a stale or virtual network adapter,
// which refuses the SRV lookup that mongodb+srv:// depends on.
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const LOCATIONS = {
  exclusive: {
    id: "exclusive",
    name: "Divic Exclusive",
    address: "Plot 55, 1st Avenue, E Close, Festac, Lagos",
    phone: "09169845311",
    typeOrder: ["standard", "deluxe", "superior"],
    rates: { standard: 40000, deluxe: 45000, superior: 50000 },
  },
  urban: {
    id: "urban",
    name: "Divic Urban",
    address: "Plot 340, 3rd Avenue, A1 Close, Festac, Lagos",
    phone: "09169845314",
    typeOrder: ["classic", "deluxe", "superior", "crown"],
    rates: { classic: 50000, deluxe: 55000, superior: 60000, crown: 65000 },
  },
};

const mk = (nums, floor, type) => nums.map((number) => ({ number, floor, type }));

const ROOM_PLAN = {
  exclusive: [
    ...mk(["G01", "G02", "G03", "G04", "G05", "G06"], 0, "standard"),
    ...mk(["101", "102", "103", "104", "105"], 1, "deluxe"),
    ...mk(["106", "107", "108", "109"], 1, "superior"),
  ],
  urban: [
    ...mk(["G01"], 0, "classic"),
    ...mk(["G02"], 0, "deluxe"),
    ...mk(["G03"], 0, "superior"),
    ...mk(["101", "102", "103", "104"], 1, "classic"),
    ...mk(["105"], 1, "deluxe"),
    ...mk(["106"], 1, "superior"),
    ...mk(["107", "108", "109"], 1, "crown"),
    ...mk(["201", "202", "203", "204"], 2, "deluxe"),
    ...mk(["205", "206"], 2, "superior"),
    ...mk(["207", "208", "209"], 2, "crown"),
  ],
};

const ROLES = ["receptionist", "cleaner", "manager", "owner"];
const ROOM_STATUSES = ["available", "occupied", "dirty", "cleaning", "maintenance"];
const BOOKING_STATUSES = ["confirmed", "in-house", "checked-out", "cancelled", "no-show"];

// What each role may reach. Enforced server-side on every route — the frontend
// copy of this map is convenience, not security.
const PERMISSIONS = {
  owner:        ["dashboard","bookings","frontdesk","rooms","guests","billing","analytics","rates","staff","audit","ai"],
  manager:      ["dashboard","bookings","frontdesk","rooms","guests","billing","analytics","rates","staff","audit","ai"],
  receptionist: ["dashboard","bookings","frontdesk","rooms","guests","billing","ai"],
  cleaner:      ["rooms"],
};

module.exports = { LOCATIONS, ROOM_PLAN, ROLES, ROOM_STATUSES, BOOKING_STATUSES, PERMISSIONS };
