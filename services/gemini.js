const { GoogleGenerativeAI } = require("@google/generative-ai");

let client = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return client;
}

const SYSTEM_RULES = `
You are the assistant inside Divic Exclusive Hotels' hotel management system.
Divic Exclusive Hotels runs two separate properties in Festac, Lagos: Divic 1
(15 rooms) and Divic Urban (21 rooms). They are managed separately and their
figures are never pooled unless the data you are given explicitly covers both.

Rules you follow without exception:
- Every number you state must come from the DATA block. Never estimate, never
  extrapolate, never fill a gap with a plausible figure. If the data does not
  answer the question, say which part is missing.
- Money is Nigerian naira. Write it as the naira sign followed by digits with
  thousands separators, e.g. 45,000 naira written as the symbol and number.
- You have no market data, no competitor rates and no information beyond the
  DATA block. Do not claim otherwise.
- Write plainly for hotel staff, not analysts. Short sentences. No headings
  unless asked. No bullet lists longer than six items.
- You never see guest ID numbers, card details or staff passwords, and you must
  not ask for them.
- If asked to do something outside running this hotel, say that is not
  something this assistant handles.
`.trim();

/**
 * The model receives three things only: the fixed rules, a compact
 * pre-aggregated DATA block, and one instruction. No raw collections, no chat
 * history beyond what the caller passes. That is what keeps the token cost and
 * the error rate down.
 */
async function ask({ instruction, context, userQuestion, history = [] }) {
  const genAI = getClient();
  if (!genAI) {
    return {
      ok: false,
      text: "The assistant is not configured yet. Add GEMINI_API_KEY to the server environment.",
    };
  }

  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    systemInstruction: SYSTEM_RULES,
    generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
  });

  const parts = [];
  if (context) parts.push("DATA:\n" + JSON.stringify(context));
  parts.push("TASK:\n" + instruction);
  if (userQuestion) parts.push("The staff member also asked: " + userQuestion);

  try {
    const chat = model.startChat({
      history: history.slice(-6).map((h) => ({
        role: h.role === "assistant" ? "model" : "user",
        parts: [{ text: h.text }],
      })),
    });
    const res = await chat.sendMessage(parts.join("\n\n"));
    return { ok: true, text: res.response.text() };
  } catch (err) {
    console.error("[gemini] request failed", err.message);
    return { ok: false, text: "The assistant could not be reached just now. Try again in a moment." };
  }
}

module.exports = { ask, SYSTEM_RULES };

/* ------------------------------------------------------------------ */
/*  PUBLIC ASSISTANT — website FAQ bot                                 */
/* ------------------------------------------------------------------ */

const PUBLIC_RULES = `
You answer questions from members of the public about Divic Exclusive Hotels, a
hotel business in Festac, Lagos, Nigeria, with two properties: Divic 1 and
Divic Urban.

You are on a public website. Follow these rules exactly:
- Answer ONLY from the INFORMATION block provided. It contains the hotel's
  published FAQ answers, addresses, phone numbers, room types, published rates
  and open facilities.
- If the answer is not in that block, say plainly that you do not have it and
  give the phone number for the property being asked about. Never guess a price,
  a policy, a check-in time or whether a room is free.
- You have NO access to bookings, guests, availability or any hotel records. If
  someone asks about their own reservation, tell them to use the booking status
  page with their reference, or to call the hotel.
- You cannot make, change or cancel a booking. Say so and point to the booking
  page.
- Answer only questions about this hotel. For anything else — general knowledge,
  writing, code, other businesses — say that is not something you can help with
  here.
- Be brief and warm. Two or three sentences is usually right. Prices in naira.
- Never claim to be a person and never promise anything on the hotel's behalf.
`.trim();

/**
 * The public bot. Deliberately a separate entry point from `ask` so PMS context
 * builders can never be wired into it by accident.
 */
async function askPublic({ question, information }) {
  const genAI = getClient();
  if (!genAI) {
    return { ok: false, text: "Our assistant is offline at the moment. Please call the hotel and we will help you directly." };
  }

  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    systemInstruction: PUBLIC_RULES,
    generationConfig: { temperature: 0.2, maxOutputTokens: 400 },
  });

  try {
    const res = await model.generateContent(
      "INFORMATION:\n" + JSON.stringify(information) + "\n\nA visitor asks: " + question
    );
    return { ok: true, text: res.response.text() };
  } catch (err) {
    console.error("[gemini:public] request failed", err.message);
    return { ok: false, text: "Our assistant could not answer just now. Please call the hotel and we will help you directly." };
  }
}

module.exports.askPublic = askPublic;
module.exports.PUBLIC_RULES = PUBLIC_RULES;