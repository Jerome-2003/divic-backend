const Booking = require("../models/Booking");
const Room = require("../models/Room");

const HOLDING_STATUSES = ["confirmed", "in-house"];

const overlaps = (aIn, aOut, bIn, bOut) => aIn < bOut && bIn < aOut;

function nightsBetween(checkIn, checkOut) {
  const ms = new Date(checkOut + "T00:00:00Z") - new Date(checkIn + "T00:00:00Z");
  return Math.round(ms / 86400000);
}

function validRange(checkIn, checkOut) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(checkIn) || !re.test(checkOut)) return "Dates must be in YYYY-MM-DD format.";
  if (checkOut <= checkIn) return "Check-out must be after check-in.";
  if (nightsBetween(checkIn, checkOut) > 60) return "A single booking cannot exceed 60 nights.";
  return null;
}

/**
 * Rooms that are free for the whole range. A room is free when it holds no
 * overlapping confirmed or in-house booking and is not out of order.
 * `ignoreBookingId` lets an existing booking be moved without colliding with itself.
 */
async function findAvailableRooms(location, checkIn, checkOut, { roomType, ignoreBookingId } = {}) {
  const roomFilter = { location, status: { $ne: "maintenance" } };
  if (roomType) roomFilter.type = roomType;
  const rooms = await Room.find(roomFilter).sort({ floor: 1, number: 1 }).lean();

  const clashQuery = {
    location,
    status: { $in: HOLDING_STATUSES },
    checkIn: { $lt: checkOut },
    checkOut: { $gt: checkIn },
  };
  if (ignoreBookingId) clashQuery._id = { $ne: ignoreBookingId };

  const clashes = await Booking.find(clashQuery).select("roomNumber").lean();
  const taken = new Set(clashes.map((b) => b.roomNumber));

  return rooms.filter((r) => !taken.has(r.number));
}

/** True when this specific room is free for the range. */
async function isRoomAvailable(location, roomNumber, checkIn, checkOut, ignoreBookingId) {
  const q = {
    location, roomNumber,
    status: { $in: HOLDING_STATUSES },
    checkIn: { $lt: checkOut },
    checkOut: { $gt: checkIn },
  };
  if (ignoreBookingId) q._id = { $ne: ignoreBookingId };
  const clash = await Booking.findOne(q).lean();
  return !clash;
}

/** Free-room counts per type, for the public website's availability widget. */
async function availabilityByType(location, checkIn, checkOut) {
  const free = await findAvailableRooms(location, checkIn, checkOut);
  return free.reduce((acc, r) => {
    acc[r.type] = (acc[r.type] || 0) + 1;
    return acc;
  }, {});
}

module.exports = {
  overlaps, nightsBetween, validRange,
  findAvailableRooms, isRoomAvailable, availabilityByType,
  HOLDING_STATUSES,
};
