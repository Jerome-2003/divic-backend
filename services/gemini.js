const { GoogleGenerativeAI } = require("@google/generative-ai");

let client = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return client;
}

const SYSTEM_RULES = `
You are the assistant inside Divic's hotel management system. Divic runs two
separate properties in Festac, Lagos: Divic Exclusive (15 rooms) and Divic
Urban (21 rooms). They are managed separately and their figures are never
pooled unless the data you are given explicitly covers both.

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
