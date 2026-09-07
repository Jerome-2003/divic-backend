const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { ROLES } = require("../utils/constants");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    // "all" means both properties — only valid for manager and owner.
    location: { type: String, enum: ["exclusive", "urban", "all"], required: true },
    phone: { type: String, trim: true },
    active: { type: Boolean, default: true },
    lastLoginAt: Date,
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
  };
};

module.exports = mongoose.model("User", userSchema);
