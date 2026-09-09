const mongoose = require("mongoose");

// One document per property. `prices` is a plain map of roomType -> naira.
const rateSchema = new mongoose.Schema(
  {
    location: { type: String, enum: ["exclusive", "urban"], required: true, unique: true },
    prices: { type: Map, of: Number, required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Rate", rateSchema);
