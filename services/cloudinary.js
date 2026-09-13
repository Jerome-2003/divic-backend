const crypto = require("crypto");

/**
 * Signed, direct-to-Cloudinary uploads for website media.
 *
 * The obvious way to accept an upload is to POST the file at this server and
 * write it to disk. That was how this worked, and on this app's free Render
 * hosting it quietly lost every file: the filesystem there is ephemeral, wiped
 * on each deploy, restart and idle spin-down, so a promo photo uploaded in the
 * morning was a broken image by the afternoon with nothing in the logs to say
 * why. A video never worked at all — it arrived base64-encoded inside a JSON
 * body, which inflates it by a third against a 12 MB body limit.
 *
 * So the file never comes here now. The browser asks this server for a
 * one-time permission to upload — a signature, valid for one upload into one
 * folder, that only someone holding the API secret can produce — and then
 * sends the file straight to Cloudinary itself. The secret stays on the
 * server, nothing large touches it, and the URL that comes back is a permanent
 * CDN link the public website can render directly.
 */

const RESOURCE_TYPES = { image: "image", video: "video" };

// Cloudinary's own ceilings on a free plan. Checked in the browser before the
// upload starts so somebody picking a 400 MB video is told immediately rather
// than after a long upload fails.
const MAX_BYTES = { image: 10 * 1024 * 1024, video: 100 * 1024 * 1024 };

const MISSING =
  "Website media uploads are not set up yet. Add CLOUDINARY_CLOUD_NAME, " +
  "CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to the server's environment " +
  "variables. Until then, paste a link to an image or video instead.";

function isConfigured() {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

/**
 * Cloudinary's signature: every parameter the upload will carry — except the
 * file, the api_key and the resource type — sorted by name, joined as a query
 * string, with the API secret appended and the lot hashed. The browser must
 * send back exactly the parameters signed here and nothing more, or Cloudinary
 * rejects the upload.
 */
function sign(params) {
  const canonical = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto
    .createHash("sha1")
    .update(canonical + process.env.CLOUDINARY_API_SECRET)
    .digest("hex");
}

/**
 * Everything a browser needs to upload one file, and nothing it could reuse:
 * the signature covers a timestamp Cloudinary rejects once it is an hour old.
 */
function signUpload(mediaType) {
  const resourceType = RESOURCE_TYPES[mediaType];
  if (!resourceType) return { ok: false, status: 400, error: "Choose an image or a video." };
  if (!isConfigured()) return { ok: false, status: 503, error: MISSING };

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = process.env.CLOUDINARY_FOLDER || "divic/site-content";

  return {
    ok: true,
    upload: {
      uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`,
      apiKey: process.env.CLOUDINARY_API_KEY,
      timestamp,
      signature: sign({ folder, timestamp }),
      folder,
      resourceType,
      maxBytes: MAX_BYTES[mediaType],
    },
  };
}

module.exports = { signUpload, isConfigured, MAX_BYTES, MISSING };
