const mongoose = require("mongoose");
const dns = require("dns");

// Windows can hand Node a resolver from a stale or virtual network adapter,
// which refuses the SRV lookup that mongodb+srv:// depends on. Setting the
// servers here rather than in server.js means every entry point gets it —
// including utils/seed.js, which does not go through server.js.
dns.setServers(["8.8.8.8", "1.1.1.1"]);

async function connectDB(uri) {
  if (!uri) throw new Error("MONGO_URI is not set");
  mongoose.set("strictQuery", true);

  // This timeout matters on Render. Without it a hanging connection — usually an
  // Atlas IP whitelist miss — sits silently past the port scan window, and the
  // deploy fails with "no open ports detected" and nothing explaining why.
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000,
    socketTimeoutMS: 45000,
  });
  console.log("[mongo] connected");

  mongoose.connection.on("disconnected", () => console.warn("[mongo] disconnected"));
  mongoose.connection.on("reconnected", () => console.log("[mongo] reconnected"));
}

module.exports = { connectDB };
