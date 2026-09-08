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

  // Starting FAQ answers for the website assistant. Managers edit these in the
  // PMS; the bot answers from them and from published property information, and
  // from nothing else. $setOnInsert so re-seeding never overwrites edits.
  const FaqEntry = require("../models/FaqEntry");
  const STARTER_FAQ = [
    { question: "What time is check-in and check-out?", answer: "Check-in is from 2pm and check-out is by 12 noon. If you need to arrive earlier or leave later, call us and we will do our best to arrange it.", category: "Your stay", order: 1 },
    { question: "Where are the two properties?", answer: "Divic 1 is at Plot 55, 1st Avenue, E Close, Festac, Lagos. Divic Urban is at Plot 340, 3rd Avenue, A1 Close, Festac, Lagos.", category: "Getting here", order: 2 },
    { question: "Do you have parking?", answer: "Yes, both properties have secure on-site parking for guests at no extra charge.", category: "Getting here", order: 3 },
    { question: "How do I pay?", answer: "You can pay online by card when you book, or settle at the front desk by cash, transfer or POS when you arrive.", category: "Booking and payment", order: 4 },
    { question: "Can I cancel or change my booking?", answer: "Call the property directly and we will help. Have your booking reference to hand.", category: "Booking and payment", order: 5 },
    { question: "What facilities do you have?", answer: "Divic Urban has an indoor pool, a bar, a gym and a restaurant. Divic 1 has a pool and both an indoor and an outdoor bar.", category: "Facilities", order: 6 },
    { question: "Is breakfast included?", answer: "Please call the property to confirm what is included with your room type, as this varies.", category: "Your stay", order: 7 },
  ];

  for (const entry of STARTER_FAQ) {
    await FaqEntry.updateOne(
      { question: entry.question },
      { $setOnInsert: { ...entry, location: "both", active: true } },
      { upsert: true }
    );
  }
  console.log("[seed] FAQ answers ready (" + STARTER_FAQ.length + " starters)");

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
