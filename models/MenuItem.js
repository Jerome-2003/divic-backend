const mongoose = require("mongoose");

/**
 * One sellable item on a facility's own list — a bottle of beer at the indoor
 * bar, jollof rice at the restaurant.
 *
 * Scoped to a single facility on purpose: Divic 1's indoor and outdoor bars
 * price independently, and the restaurant's food has nothing to do with either.
 *
 * Prices only, deliberately — there is no stock count here and selling an item
 * decrements nothing. Stock that staff have to keep accurate every shift is a
 * second job, and a wrong number is worse than no number; if it is wanted later
 * it can be added to this model without disturbing anything that sells.
 */
const menuItemSchema = new mongoose.Schema(
  {
    location: { type: String, enum: ["exclusive", "urban"], required: true, index: true },
    facility: { type: mongoose.Schema.Types.ObjectId, ref: "Facility", required: true, index: true },

    name: { type: String, required: true, trim: true },
    category: { type: String, enum: ["drink", "food", "other"], default: "drink" },
    price: { type: Number, required: true, min: 1 },

    // Taken off the list without deleting it, so past orders that reference it
    // still read correctly. A deleted item would leave old receipts pointing at
    // nothing.
    active: { type: Boolean, default: true },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// The order-entry screen asks for exactly this: what this facility sells now.
menuItemSchema.index({ facility: 1, active: 1, category: 1, name: 1 });

module.exports = mongoose.model("MenuItem", menuItemSchema);
