const Booking = require("../models/Booking");
const { findAvailableRooms } = require("./availability");

/**
 * Picks a room for a booking that nobody chose by hand.
 *
 * Taking free[0] every time fills one corridor and leaves housekeeping walking
 * the building, so this scores the candidates instead. Staff can always
 * override the pick — see PATCH /api/bookings/:id/room.
 */
async function pickRoom(location, checkIn, checkOut, roomType, opts = {}) {
  const free = await findAvailableRooms(location, checkIn, checkOut, { roomType });
  if (!free.length) return null;

  const nights = opts.nights || 1;
  const accessible = !!opts.accessibilityNeeded;

  // Rooms with a departure on the arrival morning are tight for housekeeping.
  const sameDayTurnovers = await Booking.find({
    location,
    status: { $in: ["confirmed", "in-house"] },
    checkOut: checkIn,
  }).select("roomNumber").lean();
  const turnover = new Set(sameDayTurnovers.map((b) => b.roomNumber));

  // How many rooms are already sold on each floor for this stay, so we can
  // spread arrivals out rather than stacking them.
  const overlapping = await Booking.find({
    location,
    status: { $in: ["confirmed", "in-house"] },
    checkIn: { $lt: checkOut },
    checkOut: { $gt: checkIn },
  }).select("roomNumber").lean();
  const busyNumbers = new Set(overlapping.map((b) => b.roomNumber));

  const floorLoad = {};
  free.forEach((r) => { floorLoad[r.floor] = floorLoad[r.floor] || 0; });
  busyNumbers.forEach((n) => {
    const m = String(n).match(/^G/i) ? 0 : Number(String(n)[0]);
    if (!Number.isNaN(m)) floorLoad[m] = (floorLoad[m] || 0) + 1;
  });

  const scored = free.map((room) => {
    let score = 0;
    // Lower floors for accessibility needs and for longer stays — fewer stairs
    // over more days.
    if (accessible) score += (2 - room.floor) * 40;
    else if (nights >= 4) score += (2 - room.floor) * 6;
    // Prefer the quieter floor.
    score -= (floorLoad[room.floor] || 0) * 4;
    // Give housekeeping slack where we can.
    if (turnover.has(room.number)) score -= 12;
    return { room, score };
  });

  scored.sort((a, b) => b.score - a.score || a.room.number.localeCompare(b.room.number));
  return scored[0].room;
}

module.exports = { pickRoom };
