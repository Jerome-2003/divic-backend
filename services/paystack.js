const https = require("https");

// The secret key never leaves the server. The frontend only ever sees the
// public key and the transaction reference.
function paystackRequest(path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: "api.paystack.co",
        path,
        method,
        headers: {
          Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY,
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error("Paystack returned an unreadable response")); }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Verifies a transaction with Paystack before anything is written to a folio.
 * A client-side success callback is not proof of payment — a guest can close
 * the tab mid-payment, and a hostile caller can POST whatever they like.
 */
async function verifyTransaction(reference, expectedKobo) {
  const res = await paystackRequest("/transaction/verify/" + encodeURIComponent(reference));
  if (!res || !res.status || !res.data) {
    return { ok: false, reason: "Paystack did not confirm this reference." };
  }
  const { status, amount, currency } = res.data;
  if (status !== "success") return { ok: false, reason: "Payment status from Paystack: " + status, raw: res.data };
  if (currency !== "NGN") return { ok: false, reason: "Unexpected currency: " + currency, raw: res.data };
  if (typeof expectedKobo === "number" && amount < expectedKobo) {
    return { ok: false, reason: "Paid amount is less than the amount due.", raw: res.data };
  }
  return { ok: true, amountNaira: amount / 100, raw: res.data };
}

async function initializeTransaction({ email, amountNaira, reference, metadata, callbackUrl }) {
  return paystackRequest("/transaction/initialize", "POST", {
    email,
    amount: Math.round(amountNaira * 100),   // Paystack works in kobo
    reference,
    metadata,
    callback_url: callbackUrl,
    currency: "NGN",
  });
}

module.exports = { verifyTransaction, initializeTransaction, paystackRequest };
