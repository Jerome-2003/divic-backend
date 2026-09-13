const mongoose = require("mongoose");

/**
 * One table's running order at a bar or the restaurant, from the moment it is
 * opened until it is settled and the receipt prints.
 *
 * Each line stores the item's name and price *as they were when it was
 * ordered*, not just a pointer to the MenuItem. A price rise next week must not
 * silently rewrite what a guest was charged last night, and a receipt reprinted
 * a month later has to still show what the guest actually paid.
 */
const tabLineSchema = new mongoose.Schema(
  {
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItem" },
    name: { type: String, required: true, trim: true },
    unitPrice: { type: Number, required: true, min: 0 },
    qty: { type: Number, required: true, min: 1, default: 1 },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const tabSchema = new mongoose.Schema(
  {
    location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },
    facility: { type: mongoose.Schema.Types.ObjectId, ref: "Facility", required: true, index: true },

    // Free text rather than a fixed table list: "Table 4", "Poolside 2", "Bar
    // stool 3" are all things staff actually say, and the furniture moves.
    tableName: { type: String, required: true, trim: true },
    guestName: { type: String, trim: true },

    status: { type: String, enum: ["open", "settled"], default: "open", index: true },
    lines: [tabLineSchema],

    // Settlement, mirroring models/Charge.js: "room" puts it on an in-house
    // guest's folio, "paid" is money taken at the till there and then.
    settlement: { type: String, enum: ["room", "paid"] },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", index: true },
    // The Charge this tab produced on settling. Everything downstream —
    // billing, the folio, analytics — reads Charges, so a tab has to become one
    // rather than become a second, parallel source of truth about money.
    charge: { type: mongoose.Schema.Types.ObjectId, ref: "Charge" },
    total: { type: Number, min: 0, default: 0 },

    // Printed on the receipt so a guest and the desk can refer to the same
    // piece of paper. Assigned at settle time.
    receiptNo: { type: String, trim: true, index: true },

    openedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    settledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    settledAt: Date,
  },
  { timestamps: true }
);

/** What the tab is worth right now, from its own lines. */
tabSchema.methods.computeTotal = function () {
  return (this.lines || []).reduce((sum, l) => sum + l.unitPrice * l.qty, 0);
};

// The bar screen's main query: which tables are open here.
tabSchema.index({ facility: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model("Tab", tabSchema);
