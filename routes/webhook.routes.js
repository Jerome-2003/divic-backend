const router = require("express").Router();
const express = require("express");
const BookingRequest = require("../models/BookingRequest");
const { verifyWebhookSignature, verifyTransaction } = require("../services/paystack");
const { settlePaidRequest } = require("../services/websiteBooking");

/**
 * POST /api/webhooks/paystack
 *
 * express.raw, not express.json: the signature is an HMAC of the exact bytes
 * Paystack sent, so a body that has been parsed and re-stringified will not
 * match. This route is mounted before the global JSON parser in server.js.
 *
 * Without signature verification this endpoint would let anyone POST "payment
 * succeeded" for any reference and get a room for free.
 */
router.post("/paystack", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  if (!verifyWebhookSignature(req.body, signature)) {
    console.warn("[webhook] rejected a Paystack callback with a bad signature");
    return res.sendStatus(401);
  }

  // Acknowledge immediately. Paystack retries on a slow response, and doing the
  // work first would mean duplicate deliveries for every slow database write.
  res.sendStatus(200);

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    console.error("[webhook] signature was valid but the body would not parse");
    return;
  }

  if (event.event !== "charge.success") return;

  try {
    const reference = event.data && event.data.reference;
    if (!reference) return;

    const doc = await BookingRequest.findOne({ "payment.paystackReference": reference });
    if (!doc) {
      // Not one of ours, or a front-desk payment handled elsewhere.
      return;
    }
    if (doc.payment.verified && doc.booking) return;   // already settled

    // Verify independently rather than trusting the webhook body alone. Belt
    // and braces: the signature proves the sender, verify proves the amount.
    const check = await verifyTransaction(reference, Math.round(doc.payment.amount * 100));
    if (!check.ok) {
      doc.payment.failureReason = check.reason;
      await doc.save();
      console.error("[webhook] " + reference + " failed verification: " + check.reason);
      return;
    }

    await settlePaidRequest(req.app, doc, check);
    console.log("[webhook] settled " + doc.reference);
  } catch (err) {
    console.error("[webhook] handler failed", err.message);
  }
});

module.exports = router;
