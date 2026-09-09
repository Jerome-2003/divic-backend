const mongoose = require("mongoose");

const todoSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 300 },
  location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },
  completed: { type: Boolean, default: false, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  completedAt: Date,
}, { timestamps: true });

todoSchema.index({ location: 1, completed: 1, createdAt: -1 });

module.exports = mongoose.model("Todo", todoSchema);
