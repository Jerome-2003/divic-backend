const mongoose = require("mongoose");
const { ROOM_STATUSES } = require("../utils/constants");

const roomSchema = new mongoose.Schema(
  {
    location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },
    number: { type: String, required: true },      // "101", "204", "308"
    floor: { type: Number, required: true },        // 0 ground, 1 first, 2 second
    type: { type: String, required: true },         // standard | deluxe | superior | classic | crown
    status: { type: String, enum: ROOM_STATUSES, default: "available" },
    statusNote: { type: String, trim: true },
    lastCleanedAt: Date,
    lastCleanedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// A room number is unique within its property, not across both — Exclusive 104
// and Urban 104 are different rooms.
roomSchema.index({ location: 1, number: 1 }, { unique: true });

module.exports = mongoose.model("Room", roomSchema);
