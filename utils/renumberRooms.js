/**
 * One-time migration for the room renumbering: Divic 1's old rooms (G01-G06,
 * 101-109) and Divic Urban's old rooms (G01-G03, 101-109, 201-209) are being
 * replaced by the new three-digit scheme where the first digit is the floor.
 *
 * This does NOT run automatically on boot. Run it by hand, once:
 *
 *   node utils/renumberRooms.js          — report only, changes nothing
 *   node utils/renumberRooms.js --apply  — actually deletes and reseeds
 *
 * Without --apply it only reports what it would do. Read that report before
 * ever passing --apply — if anything currently references an old room number,
 * this refuses to touch it and tells you exactly what's blocking it, rather
 * than guessing which new room a real booking should become.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const { LOCATIONS, ROOM_PLAN } = require("./constants");
const Room = require("../models/Room");
const Booking = require("../models/Booking");

const APPLY = process.argv.includes("--apply");

async function run() {
  await connectDB(process.env.MONGO_URI);

  let blocked = false;

  for (const location of Object.keys(ROOM_PLAN)) {
    const newNumbers = new Set(ROOM_PLAN[location].map((r) => r.number));
    const existing = await Room.find({ location }).lean();
    const stale = existing.filter((r) => !newNumbers.has(r.number));
    const kept = existing.filter((r) => newNumbers.has(r.number));

    console.log("\n=== " + LOCATIONS[location].name + " (" + location + ") ===");
    console.log("Rooms currently in the database:", existing.length);
    console.log("Rooms that already match the new plan (left alone):", kept.length);
    console.log("Rooms about to be removed:", stale.length);
    if (stale.length) console.log("  " + stale.map((r) => r.number).join(", "));

    if (!stale.length) {
      console.log("Nothing to remove at this property.");
      continue;
    }

    // The check that actually matters: does anything real point at a room
    // that's about to stop existing? Every status is checked, not just active
    // ones — a cancelled or checked-out booking is still a real historical
    // record that would otherwise silently point at nothing.
    const staleNumbers = stale.map((r) => r.number);
    const referencing = await Booking.find({
      location,
      roomNumber: { $in: staleNumbers },
    }).select("ref roomNumber status checkIn checkOut guest").lean();

    if (referencing.length) {
      blocked = true;
      console.log("\n  BLOCKED — " + referencing.length + " booking(s) still reference a room number that is being removed:");
      referencing.forEach((b) => {
        console.log("    " + b.ref + "  room " + b.roomNumber + "  status " + b.status +
          "  " + b.checkIn + " -> " + b.checkOut);
      });
      console.log("  Resolve these by hand before running with --apply. Nothing at " +
        LOCATIONS[location].name + " was changed.");
    } else {
      console.log("  Nothing references these rooms. Safe to remove.");
    }
  }

  if (blocked) {
    console.log("\nOne or more properties have bookings blocking the renumbering. Stopping — nothing was changed anywhere.");
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!APPLY) {
    console.log("\nReport only — nothing was changed. Re-run with --apply to actually renumber.");
    await mongoose.disconnect();
    return;
  }

  console.log("\nApplying...");
  for (const location of Object.keys(ROOM_PLAN)) {
    const newNumbers = new Set(ROOM_PLAN[location].map((r) => r.number));
    const existing = await Room.find({ location }).lean();
    const staleIds = existing.filter((r) => !newNumbers.has(r.number)).map((r) => r._id);

    if (staleIds.length) {
      await Room.deleteMany({ _id: { $in: staleIds } });
      console.log(LOCATIONS[location].name + ": removed " + staleIds.length + " old room(s)");
    }

    let created = 0;
    for (const r of ROOM_PLAN[location]) {
      const res = await Room.updateOne(
        { location, number: r.number },
        { $set: { floor: r.floor, type: r.type }, $setOnInsert: { status: "available" } },
        { upsert: true }
      );
      if (res.upsertedCount) created++;
    }
    console.log(LOCATIONS[location].name + ": " + created + " new room(s) created, " +
      (ROOM_PLAN[location].length - created) + " already existed and were left as-is");
  }

  console.log("\nDone. Run `npm run seed` next to confirm rates and facilities are still in place.");
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error("[renumberRooms] failed", e);
  process.exit(1);
});
