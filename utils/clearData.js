/**
 * Full reset: wipes bookings, guests, and billing data at BOTH properties.
 * Rooms are kept, but every room's status is reset to "available" and any
 * housekeeping notes / last-cleaned info are cleared, since those only make
 * sense in relation to the bookings that are about to disappear.
 *
 * This does NOT run automatically on boot. Run it by hand, once:
 *
 *   node utils/clearData.js          — report only, changes nothing
 *   node utils/clearData.js --apply  — actually deletes everything
 *
 * Left untouched: Users (staff logins), Rates, Facilities, SiteContent,
 * FaqEntry, AuditLog. This is guest/booking/money data only — not
 * configuration, not who can log in.
 *
 * There is no undo. Read the report before ever passing --apply.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");

const Booking = require("../models/Booking");
const BookingRequest = require("../models/BookingRequest");
const Charge = require("../models/Charge");
const Guest = require("../models/Guest");
const Notification = require("../models/Notification");
const Payment = require("../models/Payment");
const Room = require("../models/Room");

const APPLY = process.argv.includes("--apply");

const COLLECTIONS = [
  { name: "Bookings", model: Booking },
  { name: "Booking requests", model: BookingRequest },
  { name: "Charges", model: Charge },
  { name: "Guests", model: Guest },
  { name: "Notifications", model: Notification },
  { name: "Payments", model: Payment },
];

async function run() {
  await connectDB(process.env.MONGO_URI);

  console.log("\n=== Full data reset ===");
  console.log(APPLY ? "Mode: APPLY — this will delete data.\n" : "Mode: report only — nothing will change.\n");

  let totalToDelete = 0;
  for (const { name, model } of COLLECTIONS) {
    const count = await model.countDocuments();
    totalToDelete += count;
    console.log(name + ": " + count + " document(s) " + (APPLY ? "to delete" : "would be deleted"));
  }

  const roomsToReset = await Room.countDocuments({
    $or: [
      { status: { $ne: "available" } },
      { statusNote: { $exists: true, $ne: null } },
      { lastCleanedAt: { $exists: true, $ne: null } },
    ],
  });
  console.log("Rooms: " + roomsToReset + " room(s) " + (APPLY ? "will be reset to available" : "would be reset to available") +
    " (room numbers/floors/types are kept)");

  console.log("\nLeft untouched: Users, Rates, Facilities, SiteContent, FaqEntry, AuditLog.");

  if (!APPLY) {
    console.log("\nReport only — nothing was changed. Re-run with --apply to actually clear everything.");
    await mongoose.disconnect();
    return;
  }

  console.log("\nDeleting...");
  for (const { name, model } of COLLECTIONS) {
    const res = await model.deleteMany({});
    console.log(name + ": deleted " + res.deletedCount);
  }

  const roomRes = await Room.updateMany(
    {},
    { $set: { status: "available" }, $unset: { statusNote: "", lastCleanedAt: "", lastCleanedBy: "" } }
  );
  console.log("Rooms: reset " + roomRes.modifiedCount + " room(s) to available");

  console.log("\nDone. Total records removed: " + totalToDelete);
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error("[clearData] failed", e);
  process.exit(1);
});
