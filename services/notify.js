const Notification = require("../models/Notification");
const { durableWrite } = require("./durableWrite");

/**
 * Creates a notification and pushes it to the property's socket room.
 *
 * Goes through durableWrite because a notification must never be able to break
 * the action it describes — if the alert fails to save, the booking it was
 * announcing has still happened.
 */
async function notify(app, { location, type, title, body, entity, entityId, href, urgent = false }) {
  const payload = { location, type, title, body, entity, entityId, href, urgent, readBy: [] };

  const doc = await durableWrite("Notification", location, payload, () =>
    Notification.create(payload)
  );

  try {
    app?.get("io")?.to("loc:" + location).emit("notification:new", doc || payload);
  } catch (err) {
    console.error("[notify] socket emit failed", err.message);
  }
  return doc;
}

module.exports = { notify };
