const FailedWrite = require("../models/FailedWrite");

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `attemptFn`, retrying with exponential backoff. If every attempt fails,
 * persists the failure to FailedWrite for later inspection or replay rather
 * than only logging it.
 */
async function durableWrite(collectionName, location, operation, attemptFn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptFn();
    } catch (err) {
      lastErr = err;
      console.error(`[durableWrite] ${collectionName} attempt ${attempt}/${MAX_ATTEMPTS} failed`, err.message);
      if (attempt < MAX_ATTEMPTS) await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  try {
    await FailedWrite.create({
      collection: collectionName,
      location,
      operation,
      error: String(lastErr && lastErr.message ? lastErr.message : lastErr),
      attempts: MAX_ATTEMPTS,
    });
  } catch (deadLetterErr) {
    console.error("[durableWrite] FailedWrite itself failed to persist", deadLetterErr);
  }
  return null;
}

module.exports = { durableWrite };
