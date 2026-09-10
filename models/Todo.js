const mongoose = require("mongoose");

const todoSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 300 },
  // Retained for backward compatibility with existing documents. The list is
  // now private and is scoped exclusively by createdBy.
  location: { type: String, enum: ["exclusive", "urban"], required: false, index: true },
  completed: { type: Boolean, default: false, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  completedAt: Date,
}, { timestamps: true });

todoSchema.index({ createdBy: 1, completed: 1, createdAt: -1 });

todoSchema.index({ location: 1, completed: 1, createdAt: -1 });

module.exports = mongoose.model("Todo", todoSchema);
