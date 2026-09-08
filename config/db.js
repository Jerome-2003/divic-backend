const mongoose = require("mongoose");

// DNS servers are also set in utils/constants.js (loaded first by most entry
// points), but connectDB is the actual place a connection is opened, and this
// file needs to keep working even if that module load order ever changes.
const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);

async function connectDB(uri) {
  if (!uri) throw new Error("MONGO_URI is not set");
  mongoose.set("strictQuery", true);

  // This timeout matters on Render. Without it a hanging connection — usually
  // an Atlas IP whitelist miss — sits silently past the port scan window, and
  // the deploy fails with "no open ports detected" and nothing explaining why.
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000,
    socketTimeoutMS: 45000,
  });
  console.log("[mongo] connected");

  mongoose.connection.on("disconnected", () => console.warn("[mongo] disconnected"));
  mongoose.connection.on("reconnected", () => console.log("[mongo] reconnected"));
}

module.exports = { connectDB };
