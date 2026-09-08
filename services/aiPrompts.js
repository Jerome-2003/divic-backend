/**
 * Prepared prompt library.
 *
 * The point is to keep Gemini's job small. Instead of shipping raw collections
 * and asking the model to do arithmetic on them, every prepared question names
 * a `context` builder that runs real Mongo aggregations first. The model only
 * ever receives a compact, already-computed summary and is asked to interpret
 * it — so answers are cheap, fast, and can't invent numbers.
 *
 * Each entry:
 *   id          stable key the frontend sends
 *   label       the chip text staff tap
 *   group       how the frontend groups the chips
 *   roles       who may run it (checked server-side too)
 *   scope       "location" = current property, "both" = whole business
 *   context     name of the builder in aiContext.js
 *   instruction what the model is being asked to do with that context
 */

const PREPARED_PROMPTS = [
  {
    id: "today_briefing",
    label: "What needs my attention today?",
    group: "Daily running",
    roles: ["receptionist", "manager", "owner"],
    scope: "location",
    context: "operationsSnapshot",
    instruction:
      "Give a short shift briefing. Lead with anything time-critical: guests arriving, guests due to check out, unpaid balances on departing guests, and rooms not ready to sell. Keep it under 120 words, in plain sentences, no headings.",
  },
  {
    id: "rooms_not_ready",
    label: "Which rooms aren't ready to sell?",
    group: "Daily running",
    roles: ["receptionist", "cleaner", "manager", "owner"],
    scope: "location",
    context: "housekeepingSnapshot",
    instruction:
      "List the rooms that cannot be sold right now and why, grouped by floor. Then say in one sentence how many rooms are sellable tonight. Be concrete; no advice unless asked.",
  },
  {
    id: "unpaid_balances",
    label: "Who still owes money?",
    group: "Money",
    roles: ["receptionist", "manager", "owner"],
    scope: "location",
    context: "outstandingBalances",
    instruction:
      "List guests with an outstanding balance, largest first, with the room number and amount. Flag anyone checking out today or tomorrow as urgent. Under 120 words.",
  },
  {
    id: "revenue_review",
    label: "How did the last 30 days go?",
    group: "Money",
    roles: ["manager", "owner"],
    scope: "location",
    context: "revenueSummary",
    instruction:
      "Explain the last 30 days: occupancy, average daily rate, RevPAR and total room revenue. Say which room types earned most and which underperformed relative to how many rooms exist in that type. Two short paragraphs.",
  },
  {
    id: "compare_properties",
    label: "How do the two properties compare?",
    group: "Money",
    roles: ["manager", "owner"],
    scope: "both",
    context: "propertyComparison",
    instruction:
      "Compare Divic 1 and Divic Urban on occupancy, average daily rate and revenue over the last 30 days. Note that they run separately and have different room counts and price bands, so compare rates and percentages rather than raw totals alone. Say plainly which is performing better and on what measure.",
  },
  {
    id: "pricing_check",
    label: "Are my rates right?",
    group: "Money",
    roles: ["manager", "owner"],
    scope: "location",
    context: "pricingSignals",
    instruction:
      "Using occupancy per room type against its current rate, say which types look underpriced (consistently full) and which look overpriced (consistently empty). Give a specific suggested direction per type, and say clearly that this is based only on this hotel's own booking history, not the wider Festac market.",
  },
  {
    id: "booking_sources",
    label: "Where are bookings coming from?",
    group: "Guests",
    roles: ["manager", "owner"],
    scope: "location",
    context: "bookingSources",
    instruction:
      "Break down bookings by source over the last 90 days and say what the mix suggests about how the hotel is being found. If website bookings are a small share, say so plainly.",
  },
  {
    id: "repeat_guests",
    label: "Who are my regulars?",
    group: "Guests",
    roles: ["receptionist", "manager", "owner"],
    scope: "both",
    context: "repeatGuests",
    instruction:
      "List guests with more than one stay, most stays first, with total nights and total spend. Note anyone who has stayed at both properties. Suggest one practical thing the front desk could do for the top few. Under 130 words.",
  },
  {
    id: "pending_requests",
    label: "What website requests are waiting?",
    group: "Daily running",
    roles: ["receptionist", "manager", "owner"],
    scope: "location",
    context: "pendingRequests",
    instruction:
      "Summarise the pending website booking requests: guest, dates, room type, and whether a room of that type is actually free for those dates. Put the ones that can be accepted immediately first, and flag any where nothing is available.",
  },
  {
    id: "occupancy_outlook",
    label: "How full are the next two weeks?",
    group: "Daily running",
    roles: ["manager", "owner"],
    scope: "location",
    context: "forwardOccupancy",
    instruction:
      "Describe the next 14 nights of occupancy. Name the specific dates that are nearly full and the dates that are worryingly empty. Under 110 words.",
  },
  {
    id: "explain_metric",
    label: "Explain a hotel term",
    group: "Learning",
    roles: ["receptionist", "cleaner", "manager", "owner"],
    scope: "none",
    context: "none",
    instruction:
      "Explain the hotel management term the user asks about in plain English, in under 80 words, with one worked example using naira and a small Lagos hotel of about 20 rooms. If they have not named a term, briefly define occupancy, ADR and RevPAR.",
  },
];

const promptById = (id) => PREPARED_PROMPTS.find((p) => p.id === id);

const promptsForRole = (role) =>
  PREPARED_PROMPTS.filter((p) => p.roles.includes(role)).map(({ id, label, group, scope }) => ({
    id, label, group, scope,
  }));

module.exports = { PREPARED_PROMPTS, promptById, promptsForRole };
