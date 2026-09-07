const mongoose = require("mongoose");

// Dead-letter store for writes that failed every retry. A persistence failure
// should be discoverable and replayable, not lost in a scrolling log.
const failedWriteSchema = new mongoose.Schema(
  {
    collection: { type: String, required: true },
    location: String,
    operation: mongoose.Schema.Types.Mixed,   // the payload, kept for replay
    error: String,
    attempts: Number,
    replayed: { type: Boolean, default: false },
    replayedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model("FailedWrite", failedWriteSchema);
