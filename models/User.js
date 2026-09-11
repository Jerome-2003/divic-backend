const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { ROLES } = require("../utils/constants");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    // "all" means both properties — only valid for manager and owner. A
    // facility user always has a concrete property, never "all".
    location: { type: String, enum: ["exclusive", "urban", "all"], required: true },

    // Which facilities a facility user covers. One bartender might cover the
    // indoor and outdoor bars at Divic 1; another only the restaurant
    // at Divic Urban. Every entry must sit at the user's own property —
    // enforced in routes/staff.routes.js.
    assignedFacilities: [{ type: mongoose.Schema.Types.ObjectId, ref: "Facility" }],
    phone: { type: String, trim: true },
    active: { type: Boolean, default: true },
    lastLoginAt: Date,

    // Set the first time this account dismisses or finishes the guided tour.
    // Tracked here rather than in the browser so it follows the account, not
    // the device — a receptionist who tours the app on the front-desk PC
    // should not be offered it again just for signing in on their phone.
    tourSeenAt: Date,

    // Password protection. A user gets 5 failed password attempts; the 5th
    // failure locks the account until a manager or owner explicitly unlocks it.
    failedLoginAttempts: { type: Number, default: 0, min: 0 },
    loginLockedAt: Date,
    loginUnlockedAt: Date,
  },
  { timestamps: true }
);

userSchema.methods.setPassword = async function (plain) {
  this.passwordHash = await bcrypt.hash(plain, 12);
};

userSchema.methods.checkPassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

// Never let the hash leave the server, even by accident.
userSchema.methods.toSafeJSON = function () {
  return {
    id: this._id, name: this.name, username: this.username, role: this.role,
    location: this.location, phone: this.phone, active: this.active,
    assignedFacilities: (this.assignedFacilities || []).map(String),
    tourSeenAt: this.tourSeenAt || null,
  };
};

module.exports = mongoose.model("User", userSchema);
