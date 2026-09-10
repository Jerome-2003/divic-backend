const nodemailer = require("nodemailer");

/**
 * SMTP mail sending. Same shape as services/gemini.js: if it is not
 * configured, calls no-op with a clear message instead of throwing, so a
 * missing env var never breaks a booking, a payment or a website request.
 *
 * Required env vars:
 *   SMTP_HOST, SMTP_USER, SMTP_PASS
 * Optional:
 *   SMTP_PORT   (default 587)
 *   SMTP_SECURE ("true" for port 465, otherwise leave unset)
 *   MAIL_FROM   (default: "Divic Hotels" <SMTP_USER>)
 */

let transporter;
function getTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

/**
 * Sends one email. Never throws — a failed send is logged and swallowed so it
 * can safely be fired without awaiting, the same way logAction is. `to` may be
 * a single address, a comma-separated list, or falsy (skipped).
 */
async function sendMail({ to, subject, text }) {
  if (!to) return { ok: false, reason: "no recipient" };
  const t = getTransporter();
  if (!t) {
    console.warn("[mailer] SMTP is not configured — skipped: " + subject + " to " + to);
    return { ok: false, reason: "not configured" };
  }
  try {
    await t.sendMail({
      from: process.env.MAIL_FROM || '"Divic Hotels" <' + process.env.SMTP_USER + ">",
      to, subject, text,
    });
    return { ok: true };
  } catch (err) {
    console.error("[mailer] send failed — " + subject + " to " + to, err.message);
    return { ok: false, reason: err.message };
  }
}

module.exports = { sendMail };
