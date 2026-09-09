const mongoose = require("mongoose");

const auditSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    userName: String,     // kept flat so the log still reads if a staff account is deleted
    role: String,
    location: { type: String, enum: ["exclusive", "urban", "all"], index: true },
    action: { type: String, required: true },        // human-readable line
    entity: String,                                  // "Booking" | "Room" | "Payment" | ...
    entityId: mongoose.Schema.Types.ObjectId,
    before: mongoose.Schema.Types.Mixed,
    after: mongoose.Schema.Types.Mixed,
    ip: String,
  },
  { timestamps: false }
);

module.exports = mongoose.model("AuditLog", auditSchema);
