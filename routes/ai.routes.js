const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { requireAuth, requireModule, scopeLocation } = require("../middleware/auth");
const { promptsForRole, promptById } = require("../services/aiPrompts");
const { buildContext } = require("../services/aiContext");
const { ask } = require("../services/gemini");
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

    let instruction, contextName, scope;
    if (promptId) {
      const prompt = promptById(promptId);
      if (!prompt) return res.status(404).json({ error: "That question is not one of the prepared ones." });
      if (!prompt.roles.includes(req.user.role)) {
        return res.status(403).json({ error: "Your role does not have access to that question." });
      }
      instruction = prompt.instruction;
      contextName = prompt.context;
      scope = prompt.scope;
    } else {
      if (!question || question.trim().length < 3) {
        return res.status(400).json({ error: "Type a question, or tap one of the suggestions." });
      }
      if (question.length > 500) {
        return res.status(400).json({ error: "Keep your question under 500 characters." });
      }
      // Free text still gets a pre-built context. Managers and owners get the
      // fuller picture; receptionists get operations only.
      instruction = "Answer the staff member's question using only the DATA block. If the answer is not in the data, say so and suggest which screen in the system would show it.";
      contextName = ["manager", "owner"].includes(req.user.role) ? "revenueSummary" : "operationsSnapshot";
      scope = "location";
    }

    const context = scope === "none" ? null : await buildContext(contextName, req.location);

    const result = await ask({
      instruction,
      context,
      userQuestion: promptId ? question : question,
      history: Array.isArray(history) ? history : [],
    });

    if (!result.ok) return res.status(503).json({ error: result.text });

    logAction(req, {
      action: "Asked the assistant: " + (promptId || question.slice(0, 60)),
      entity: "AI", location: req.location,
    });

    res.json({
      answer: result.text,
      promptId: promptId || null,
      // Returned so the UI can show exactly what the model was given. Staff
      // trust a number far more when they can see where it came from.
      contextUsed: contextName === "none" ? null : contextName,
      context,
    });
  } catch (e) { next(e); }
});

module.exports = router;
