const nodemailer = require("nodemailer");

/**
 * Generic SMTP transport, shared by every guest-facing email this app sends.
 *
 * Deliberately provider-agnostic: SMTP_HOST/PORT/USER/PASS work the same
 * whether they point at a Google Workspace or Zoho mailbox for the hotel's
 * own domain, or at the SMTP relay of a transactional service like Resend
 * or SendGrid. Whichever is used, set the five SMTP_* variables below in
 * the environment — nothing else in this file needs to change.
 *
 * Email here is optional infrastructure, never load-bearing: a guest has
 * already given a phone number on every booking request, and the hotel
 * calls to confirm regardless of whether this sends. So a missing
 * configuration or a failed send is caught and logged, never thrown — the
 * booking itself must never fail, or look like it failed, because a mail
 * server was unreachable.
 */
let transporter;
let warnedMissingConfig = false;

function getTransporter() {
  if (transporter !== undefined) return transporter;
  if (!process.env.SMTP_HOST) {
    if (!warnedMissingConfig) {
      console.warn("[mailer] SMTP_HOST is not set — guest emails are disabled until it is.");
      warnedMissingConfig = true;
    }
    transporter = null;
    return transporter;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    // Port 465 is implicit TLS; 587 (the default here) negotiates STARTTLS
    // itself, so secure only needs to be forced on for the former.
    secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return transporter;
}

/** Sends one email. Never throws — returns { sent, error? } instead. */
async function sendMail({ to, subject, html, text }) {
  if (!to) return { sent: false, error: "no recipient" };
  const t = getTransporter();
  if (!t) return { sent: false, error: "mailer not configured" };
  try {
    await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to, subject, html, text,
    });
    return { sent: true };
  } catch (err) {
    console.error("[mailer] send failed:", err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendMail };
