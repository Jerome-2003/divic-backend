const { Resend } = require("resend");

/**
 * Guest-facing email, sent over Resend's HTTP API rather than SMTP.
 *
 * This app's free-tier Render hosting blocks outbound traffic to SMTP ports
 * (25/465/587) entirely as of September 2025 — a real Zoho mailbox with
 * correct credentials still times out, because the connection never reaches
 * the port at all. An HTTP API sidesteps that outright: it's just an HTTPS
 * POST, the same as any other API call this app already makes (Paystack,
 * Gemini), so nothing about hosting has to change to use it.
 *
 * Email here is optional infrastructure, never load-bearing: a guest has
 * already given a phone number on every booking request, and the hotel
 * calls to confirm regardless of whether this sends. So a missing API key
 * or a failed send is caught and logged, never thrown — the booking itself
 * must never fail, or look like it failed, because Resend was unreachable.
 */
let client;
let warnedMissingConfig = false;

function getClient() {
  if (client !== undefined) return client;
  if (!process.env.RESEND_API_KEY) {
    if (!warnedMissingConfig) {
      console.warn("[mailer] RESEND_API_KEY is not set — guest emails are disabled until it is.");
      warnedMissingConfig = true;
    }
    client = null;
    return client;
  }
  client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

/** Sends one email. Never throws — returns { sent, error? } instead. */
async function sendMail({ to, subject, html, text }) {
  if (!to) return { sent: false, error: "no recipient" };
  const r = getClient();
  if (!r) return { sent: false, error: "mailer not configured" };
  if (!process.env.MAIL_FROM) return { sent: false, error: "MAIL_FROM is not set" };
  try {
    const { error } = await r.emails.send({
      from: process.env.MAIL_FROM,
      to, subject, html, text,
    });
    if (error) {
      console.error("[mailer] send failed:", error.name, error.message);
      return { sent: false, error: error.message };
    }
    return { sent: true };
  } catch (err) {
    console.error("[mailer] send failed:", err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendMail };
