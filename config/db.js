const mongoose = require("mongoose");

// serverSelectionTimeoutMS matters on Render: without it a hanging connection
// (usually an Atlas IP whitelist miss) sits silently past the port scan window
// and the deploy reports "no open ports" with no error to explain why.
async function connectDB(uri) {
  if (!uri) throw new Error("MONGO_URI is not set");
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000,
    socketTimeoutMS: 45000,
  });
  console.log("[mongo] connected");

  mongoose.connection.on("disconnected", () => console.warn("[mongo] disconnected"));
  mongoose.connection.on("reconnected", () => console.log("[mongo] reconnected"));
}

module.exports = { connectDB };
