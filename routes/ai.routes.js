const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { requireAuth, requireModule, scopeLocation } = require("../middleware/auth");
const { promptsForRole, promptById } = require("../services/aiPrompts");
const { buildContext } = require("../services/aiContext");
const { ask } = require("../services/gemini");
const { runAgent, runPreparedPrompt, fallbackHelp } = require("../services/agent");
const { logAction } = require("../services/audit");

router.use(requireAuth, requireModule("ai"));

// Gemini calls cost money and time, so they are capped per user.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  keyGenerator: (req) => req.user.id,
  message: { error: "You are asking faster than the assistant can keep up. Wait a moment." },
});

/**
 * GET /api/ai/prompts
 * The chips the frontend renders. Filtered by role, so a receptionist is never
 * shown a revenue question they would be refused anyway.
 */
router.get("/prompts", (req, res) => {
  res.json(promptsForRole(req.user.role));
});

/**
 * POST /api/ai/ask  { promptId, location?, question? }
 *
 * A prepared prompt runs its own aggregation first and sends Gemini a small
 * summary. A free-text question with no promptId gets the general operations
 * snapshot — still pre-aggregated, never the raw collections.
 */
router.post("/ask", aiLimiter, scopeLocation, async (req, res, next) => {
  try {
    const { promptId, question, history } = req.body;
    const q = String(question || "").trim();

    if (promptId) {
      const prompt = promptById(promptId);
      if (!prompt) return res.status(404).json({ error: "That question is not one of the prepared ones." });
      if (!prompt.roles.includes(req.user.role)) {
        return res.status(403).json({ error: "Your role does not have access to that question." });
      }

      // Prepared questions are ALWAYS answered without Gemini first. This is
      // what keeps the assistant usable when Gemini is unavailable.
      const direct = await runPreparedPrompt(promptId, q, req.user, Array.isArray(history) ? history : [], req.location);
      if (direct.ok) {
        logAction(req, { action: "Asked deterministic assistant question: " + promptId, entity: "AI", location: req.location });
        return res.json({
          answer: direct.text, promptId, mode: direct.mode || "database",
          data: direct.data || null, contextUsed: prompt.context,
        });
      }

      return res.status(503).json({ error: direct.text || "That prepared question could not be answered." });
    }

    if (q.length < 3) return res.status(400).json({ error: "Type a question, or tap one of the suggestions." });
    if (q.length > 500) return res.status(400).json({ error: "Keep your question under 500 characters." });

    // Free text: deterministic agent first. It can identify names, booking
    // references, room numbers, facilities, analytics and all prepared
    // questions without a model. Gemini is only a classifier fallback.
    const agentResult = await runAgent({ question: q, user: req.user, location: req.location });
    if (agentResult.ok && agentResult.mode !== "gemini") {
      logAction(req, { action: "Asked deterministic assistant: " + q.slice(0, 60), entity: "AI", location: req.location });
      return res.json({
        answer: agentResult.text, promptId: null, mode: agentResult.mode || "database",
        action: agentResult.action || null, data: agentResult.data || null,
      });
    }

    // Last-resort model answer. This path is allowed to fail when Gemini is
    // unavailable, but known hotel questions should already have returned.
    const contextName = ["manager", "owner"].includes(req.user.role) ? "revenueSummary" : "operationsSnapshot";
    const context = await buildContext(contextName, req.location);
    const result = await ask({
      instruction: "Answer the staff member's question using only the DATA block. If the answer is not in the data, say so and suggest which screen in the system would show it.",
      context, userQuestion: q, history: Array.isArray(history) ? history : [],
    });
    if (!result.ok) return res.status(503).json({ error: result.text || "The AI service is temporarily unavailable. Use one of the prepared questions or command templates." });

    logAction(req, { action: "Asked Gemini assistant: " + q.slice(0, 60), entity: "AI", location: req.location });
    return res.json({ answer: result.text, promptId: null, mode: "gemini", contextUsed: contextName, context });
  } catch (e) { next(e); }
});

module.exports = router;
