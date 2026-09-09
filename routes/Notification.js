const mongoose = require("mongoose");

// Staff-facing alerts. Deliberately sparse: a notification for every routine
// action trains people to ignore all of them, including the one that matters.
const notificationSchema = new mongoose.Schema(
  {
    location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },
    type: {
      type: String,
      enum: [
        "request:new",          // unpaid website request waiting on the desk
        "booking:auto",         // paid website booking, room assigned automatically
        "booking:unassigned",   // paid but NO room free — needs a human now
        "payment:received",
        "facility:status",
      ],
      required: true,
    },
    title: { type: String, required: true },
    body: { type: String },
    entity: String,                                   // "Booking" | "BookingRequest" | ...
    entityId: mongoose.Schema.Types.ObjectId,
    href: String,                                     // where the PMS should navigate
    urgent: { type: Boolean, default: false },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

notificationSchema.index({ location: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
