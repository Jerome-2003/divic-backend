const mongoose = require("mongoose");

// Guests are shared across both properties so a repeat guest is recognised at
// either address. Bookings stay strictly per-property.
const guestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true, index: true },
    email: { type: String, trim: true, lowercase: true },
    idType: { type: String, enum: ["NIN", "Passport", "Driver's licence", "Voter's card", "None"], default: "None" },
    idNumber: { type: String, trim: true },
    address: { type: String, trim: true },
    notes: { type: String, trim: true },
    blacklisted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

guestSchema.index({ name: "text", phone: "text", email: "text" });

module.exports = mongoose.model("Guest", guestSchema);
