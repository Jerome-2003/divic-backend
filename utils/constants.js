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
    // Display name only — every Room/Booking/User document and every route
    // still uses the key "exclusive". Renaming the key would touch every
    // document already in the database for a change that only needs to
    // affect what appears on screen.
    name: "Divic 1",
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
    ...mk(["101", "102", "103", "104", "105", "106"], 1, "standard"),
    ...mk(["201", "202", "203", "207", "208"], 2, "deluxe"),
    ...mk(["204", "205", "206", "209"], 2, "superior"),
  ],
  urban: [
    ...mk(["103", "201", "206", "207", "208"], null, "classic"),
    ...mk(["102", "202", "301", "306", "307", "308"], null, "deluxe"),
    ...mk(["101", "209", "302", "309"], null, "superior"),
    ...mk(["203", "204", "205", "303", "304", "305"], null, "crown"),
  ],
};

// Urban's room numbers span three floors within a single type (e.g. deluxe has
// rooms on 1, 2 and 3), so mk()'s single fixed floor argument does not fit —
// derive the floor from the room number itself instead: first digit of a
// three-digit number is the floor.
ROOM_PLAN.urban = ROOM_PLAN.urban.map((r) => ({ ...r, floor: Number(r.number[0]) }));

// The two properties' facilities. `sellsItems` is what decides whether a
// facility can post charges at all — a gym attendant is never shown a till.
const FACILITY_TYPES = ["pool", "bar", "gym", "restaurant"];
const FACILITY_STATUSES = ["open", "closed", "maintenance"];

const FACILITY_PLAN = {
  exclusive: [
    { name: "Pool", slug: "pool", type: "pool", sellsItems: false, openingHours: "7am \u2013 9pm" },
    { name: "Indoor bar", slug: "indoor-bar", type: "bar", sellsItems: true, openingHours: "12pm \u2013 12am" },
    { name: "Outdoor bar", slug: "outdoor-bar", type: "bar", sellsItems: true, openingHours: "4pm \u2013 12am" },
  ],
  urban: [
    { name: "Indoor pool", slug: "indoor-pool", type: "pool", sellsItems: false, openingHours: "6am \u2013 10pm" },
    { name: "Bar", slug: "bar", type: "bar", sellsItems: true, openingHours: "12pm \u2013 12am" },
    { name: "Gym", slug: "gym", type: "gym", sellsItems: false, openingHours: "6am \u2013 10pm" },
    { name: "Restaurant", slug: "restaurant", type: "restaurant", sellsItems: true, openingHours: "7am \u2013 10pm" },
  ],
};

const ROLES = ["receptionist", "cleaner", "manager", "facility", "owner"];
const ROOM_STATUSES = ["available", "occupied", "dirty", "cleaning", "maintenance"];
const BOOKING_STATUSES = ["confirmed", "in-house", "checked-out", "cancelled", "no-show"];
const CHARGE_SETTLEMENTS = ["room", "paid"];

// What each role may reach. Enforced server-side on every route — the frontend
// copy of this map is convenience, not security.
const PERMISSIONS = {
  owner:        ["dashboard","bookings","frontdesk","rooms","guests","billing","facilities","pos","analytics","rates","staff","audit","ai","content","notifications","todos"],
  manager:      ["dashboard","bookings","frontdesk","rooms","guests","billing","facilities","pos","analytics","rates","staff","audit","ai","content","notifications","todos"],
  receptionist: ["dashboard","bookings","frontdesk","rooms","guests","billing","ai","notifications"],
  cleaner:      ["rooms","notifications","ai","todos"],
  // Facility staff can use the assistant for facility, till and operational questions;
  // the agent itself enforces what records this role can see.
  facility:     ["facilities","pos","notifications","ai","todos"],
};

module.exports = {
  LOCATIONS, ROOM_PLAN, FACILITY_PLAN, FACILITY_TYPES, FACILITY_STATUSES,
  ROLES, ROOM_STATUSES, BOOKING_STATUSES, CHARGE_SETTLEMENTS, PERMISSIONS,
};
