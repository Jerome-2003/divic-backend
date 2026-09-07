/**
 * Seeds the two properties, their rooms, facilities, rates and a starting owner
 * account. Safe to re-run: rooms and facilities are upserted, a facility's
 * status is only set when it is first created, and existing users are left
 * alone.
 *
 *   npm run seed
 */
require("dotenv").config();
const { connectDB } = require("../config/db");
const { LOCATIONS, ROOM_PLAN, FACILITY_PLAN } = require("./constants");
const Room = require("../models/Room");
const Facility = require("../models/Facility");
const Rate = require("../models/Rate");
const User = require("../models/User");
const mongoose = require("mongoose");

async function run() {
  await connectDB(process.env.MONGO_URI);

  for (const location of Object.keys(ROOM_PLAN)) {
    for (const r of ROOM_PLAN[location]) {
      await Room.updateOne(
        { location, number: r.number },
        { $set: { floor: r.floor, type: r.type }, $setOnInsert: { status: "available" } },
        { upsert: true }
      );
    }
    const count = await Room.countDocuments({ location });
    console.log("[seed] " + LOCATIONS[location].name + ": " + count + " rooms");

    await Rate.updateOne(
      { location },
      { $setOnInsert: { prices: LOCATIONS[location].rates } },
      { upsert: true }
    );

    // Status is $setOnInsert only: re-running the seed must never reopen a
    // facility a manager has closed, and must not wipe their status note.
    for (const f of FACILITY_PLAN[location] || []) {
      await Facility.updateOne(
        { location, slug: f.slug },
        {
          $set: { name: f.name, type: f.type, sellsItems: f.sellsItems, openingHours: f.openingHours },
          $setOnInsert: { status: "open" },
        },
        { upsert: true }
      );
    }
    const facilityCount = await Facility.countDocuments({ location });
    console.log("[seed] " + LOCATIONS[location].name + ": " + facilityCount + " facilities");
  }

  const ownerExists = await User.findOne({ role: "owner" });
  if (!ownerExists) {
    const owner = new User({
      name: "Divic Owner",
      username: "owner",
      role: "owner",
      location: "all",
    });
    await owner.setPassword(process.env.SEED_OWNER_PASSWORD || "ChangeThisNow1");
    await owner.save();
    console.log("[seed] created owner account — username 'owner'");
    console.log("[seed] sign in and change this password immediately");
  } else {
    console.log("[seed] owner account already exists, leaving it alone");
  }

  await mongoose.connection.close();
  console.log("[seed] done");
}

run().catch((e) => { console.error("[seed] failed", e); process.exit(1); });
