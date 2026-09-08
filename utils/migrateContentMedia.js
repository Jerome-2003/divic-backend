/**
 * One-time migration: copies any existing SiteContent.imageUrl into the new
 * mediaType/mediaUrl fields, then the field is dropped from the schema (it no
 * longer exists in models/SiteContent.js as of this change).
 *
 * Run once by hand:
 *
 *   node utils/migrateContentMedia.js          — report only, changes nothing
 *   node utils/migrateContentMedia.js --apply  — actually copies the data
 *
 * Read the report before applying. If it says zero documents have imageUrl
 * set, there is nothing to migrate and you can skip straight to deploying the
 * rest of this change.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");

const APPLY = process.argv.includes("--apply");

async function run() {
  await connectDB(process.env.MONGO_URI);

  // Query the raw collection rather than the Mongoose model — the model no
  // longer declares imageUrl, so Mongoose would strip it out before we ever
  // saw it.
  const coll = mongoose.connection.collection("sitecontents");
  const withImage = await coll.find({ imageUrl: { $exists: true, $ne: null, $ne: "" } }).toArray();

  console.log("Documents with an imageUrl set:", withImage.length);
  withImage.forEach((d) => console.log("  " + (d.key || d._id) + " -> " + d.imageUrl));

  if (!withImage.length) {
    console.log("Nothing to migrate.");
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log("\nReport only — nothing was changed. Re-run with --apply to copy this data.");
    await mongoose.disconnect();
    return;
  }

  let moved = 0;
  for (const doc of withImage) {
    await coll.updateOne(
      { _id: doc._id },
      { $set: { mediaType: "image", mediaUrl: doc.imageUrl }, $unset: { imageUrl: "" } }
    );
    moved++;
  }
  console.log("\nMoved " + moved + " document(s) from imageUrl to mediaType/mediaUrl.");
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error("[migrateContentMedia] failed", e);
  process.exit(1);
});
