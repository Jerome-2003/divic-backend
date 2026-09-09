/**
 * Full PMS reset while preserving the owner account.
 *
 * REPORT ONLY (default):
 *   node utils/clearData.js
 *
 * APPLY:
 *   node utils/clearData.js --apply
 *
 * Optional owner selector when more than one owner exists:
 *   node utils/clearData.js --apply --owner=owner
 *
 * What is removed/reset:
 *   - all users except the selected owner
 *   - bookings
 *   - booking requests
 *   - charges
 *   - guests
 *   - notifications
 *   - payments
 *   - audit logs
 *   - failed writes
 *   - website FAQ/content records created in the database are NOT removed
 *
 * Configuration kept so the PMS still works after the reset:
 *   - rooms (reset to available; housekeeping fields cleared)
 *   - rates
 *   - facilities (status is kept)
 *   - site content
 *   - FAQ entries
 *
 * The owner's password, role, username, location and account identity are kept.
 * There is no undo. Review the report before using --apply.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");

const AuditLog = require("../models/AuditLog");
const Booking = require("../models/Booking");
const BookingRequest = require("../models/BookingRequest");
const Charge = require("../models/Charge");
const FailedWrite = require("../models/FailedWrite");
const Guest = require("../models/Guest");
const Notification = require("../models/Notification");
const Payment = require("../models/Payment");
const Room = require("../models/Room");
const User = require("../models/User");

const APPLY = process.argv.includes("--apply");
const ownerArg = process.argv.find((arg) => arg.startsWith("--owner="));
const requestedOwnerUsername = ownerArg ? ownerArg.slice("--owner=".length).trim().toLowerCase() : null;

const COLLECTIONS = [
  { name: "Bookings", model: Booking },
  { name: "Booking requests", model: BookingRequest },
  { name: "Charges", model: Charge },
  { name: "Guests", model: Guest },
  { name: "Notifications", model: Notification },
  { name: "Payments", model: Payment },
  { name: "Audit logs", model: AuditLog },
  { name: "Failed writes", model: FailedWrite },
];

async function chooseOwner() {
  const owners = await User.find({ role: "owner" }).sort({ createdAt: 1, _id: 1 });

  if (owners.length === 0) {
    throw new Error("No owner account exists. Aborting so the reset cannot leave the PMS without an owner.");
  }

  if (requestedOwnerUsername) {
    const selected = owners.find((u) => u.username === requestedOwnerUsername);
    if (!selected) {
      throw new Error(`Owner '${requestedOwnerUsername}' was not found. Aborting without changing data.`);
    }
    return { selected, ownerCount: owners.length };
  }

  if (owners.length > 1) {
    const names = owners.map((u) => `${u.username} (${u.name})`).join(", ");
    throw new Error(
      `There are ${owners.length} owner accounts: ${names}. Use --owner=<username> so the account to preserve is explicit.`
    );
  }

  return { selected: owners[0], ownerCount: 1 };
}

async function run() {
  await connectDB(process.env.MONGO_URI);

  console.log("\n=== DIVIC PMS RESET ===");
  console.log(APPLY ? "Mode: APPLY — data will be changed.\n" : "Mode: REPORT ONLY — nothing will be changed.\n");

  const { selected: owner, ownerCount } = await chooseOwner();
  const usersToDelete = Math.max(0, await User.countDocuments({ _id: { $ne: owner._id } }));

  console.log(`Owner kept: ${owner.name} (@${owner.username})`);
  console.log(`Owner accounts found: ${ownerCount}`);
  console.log(`Other user/staff accounts to delete: ${usersToDelete}\n`);

  let transactionalTotal = 0;
  for (const { name, model } of COLLECTIONS) {
    const count = await model.countDocuments();
    transactionalTotal += count;
    console.log(`${name}: ${count} document(s) ${APPLY ? "to delete" : "would be deleted"}`);
  }

  const roomCount = await Room.countDocuments();
  console.log(`Rooms: ${roomCount} will be kept and reset to available`);
  console.log("Rates: kept");
  console.log("Facilities: kept");
  console.log("Site content: kept");
  console.log("FAQ entries: kept");

  if (!APPLY) {
    console.log("\nReport only — nothing was changed.");
    console.log("Re-run with --apply to perform the reset.");
    await mongoose.disconnect();
    return;
  }

  console.log("\nApplying reset...");

  // Delete all users except the one owner explicitly selected above.
  const userRes = await User.deleteMany({ _id: { $ne: owner._id } });
  console.log(`Other users/staff: deleted ${userRes.deletedCount}`);

  for (const { name, model } of COLLECTIONS) {
    const res = await model.deleteMany({});
    console.log(`${name}: deleted ${res.deletedCount}`);
  }

  // Keep the room inventory itself, but return operational state to a clean slate.
  const roomRes = await Room.updateMany(
    {},
    {
      $set: { status: "available" },
      $unset: { statusNote: "", lastCleanedAt: "", lastCleanedBy: "" },
    }
  );
  console.log(`Rooms: reset ${roomRes.modifiedCount} room(s) to available`);

  // Ensure the preserved owner remains active. Do not touch their password or username.
  await User.updateOne({ _id: owner._id }, { $set: { active: true } });
  console.log(`Owner: preserved @${owner.username} and confirmed active`);

  console.log(`\nReset complete. Operational/history records removed: ${transactionalTotal}.`);
  console.log("Configuration was kept so the PMS remains configured for both properties.");

  await mongoose.disconnect();
}

run().catch(async (e) => {
  console.error("[clearData] failed:", e.message || e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
