const { sendMail } = require("./mailer");
const { LOCATIONS } = require("../utils/constants");

const money = (n) => "₦" + Number(n || 0).toLocaleString("en-NG");

/** "2026-09-20" -> "Sunday, 20 September 2026" */
const longDate = (isoDate) =>
  new Date(isoDate + "T00:00:00").toLocaleDateString("en-NG", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

/* The backend has no friendly room-type name anywhere — "standard", "deluxe"
   and so on are the room type itself, not a display label. The website's own
   CONTENT (src/data/properties.js) has "Standard Room" etc., but that lives
   in the other repo. Capitalizing the slug is the honest middle ground. */
const roomName = (type) => type.charAt(0).toUpperCase() + type.slice(1) + " Room";

/**
 * Sent the moment a booking request is lodged from the website — a plain
 * receipt of what was submitted, so the guest has their reference and dates
 * in writing even before the hotel calls to confirm.
 *
 * Deliberately separate from anything to do with payment: this fires from
 * POST /api/public/booking-requests regardless of whether the guest goes on
 * to pay online, and says plainly that no money has been taken and no room
 * is held yet. A guest who does pay by card gets Paystack's own receipt for
 * that separately — this email never mentions payment status, so the two
 * can never contradict each other.
 */
async function sendBookingRequestReceivedEmail(doc) {
  if (!doc.guestEmail) return { sent: false, error: "no email on file" };

  const loc = LOCATIONS[doc.location];
  const room = roomName(doc.roomType);
  const subject = `We've received your request — ${doc.reference}`;

  const text = [
    `Hi ${doc.guestName},`,
    ``,
    `Thank you for requesting a stay at ${loc.name}. Here is what you sent us:`,
    ``,
    `Reference: ${doc.reference}`,
    `Room: ${room}`,
    `Arrival: ${longDate(doc.checkIn)}`,
    `Departure: ${longDate(doc.checkOut)}`,
    `Nights: ${doc.nights}`,
    `Quoted total: ${money(doc.quotedTotal)}`,
    ``,
    `No payment has been taken and no room is held yet. The house will call you ` +
      `on ${doc.guestPhone} shortly to confirm your stay.`,
    ``,
    `Questions in the meantime? Call ${loc.name} on ${loc.phone}.`,
    ``,
    `— ${loc.name}`,
  ].join("\n");

  const html = `
    <div style="font-family:Georgia,serif;color:#2C2A29;max-width:480px;margin:0 auto;">
      <p>Hi ${escapeHtml(doc.guestName)},</p>
      <p>Thank you for requesting a stay at ${escapeHtml(loc.name)}. Here is what you sent us:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        ${row("Reference", doc.reference)}
        ${row("Room", room)}
        ${row("Arrival", longDate(doc.checkIn))}
        ${row("Departure", longDate(doc.checkOut))}
        ${row("Nights", String(doc.nights))}
        ${row("Quoted total", money(doc.quotedTotal))}
      </table>
      <p><strong>No payment has been taken and no room is held yet.</strong>
         The house will call you on ${escapeHtml(doc.guestPhone)} shortly to confirm your stay.</p>
      <p>Questions in the meantime? Call ${escapeHtml(loc.name)} on ${escapeHtml(loc.phone)}.</p>
      <p>— ${escapeHtml(loc.name)}</p>
    </div>
  `;

  return sendMail({ to: doc.guestEmail, subject, text, html });
}

function row(label, value) {
  return `<tr>
    <td style="padding:6px 12px 6px 0;color:#6B6664;white-space:nowrap;">${escapeHtml(label)}</td>
    <td style="padding:6px 0;">${escapeHtml(value)}</td>
  </tr>`;
}

/** Nothing here is ever HTML by design — a guest's own name goes straight into this template. */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

module.exports = { sendBookingRequestReceivedEmail };
