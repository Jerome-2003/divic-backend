
const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { requireAuth, requireModule, scopeLocation } = require("../middleware/auth");
const { promptsForRole, promptById } = require("../services/aiPrompts");
const { runAgent, runPreparedPrompt, fallbackHelp } = require("../services/agent");
const { logAction } = require("../services/audit");

router.use(requireAuth, requireModule("ai"));

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user.id,
  message: { error: "You are asking faster than the assistant can keep up. Wait a moment." },
});

router.get("/prompts", (req, res) => {
  res.json([
    ...promptsForRole(req.user.role),
    {
      id: "command_help",
      label: "How can I ask the assistant?",
      group: "Commands",
      scope: "location",
    },
  ]);
});

router.get("/commands", (req, res) => {
  res.json({
    commands: [
      { label: "GUEST - NAME: ___", description: "Find a guest and see their stays." },
      { label: "BOOKING - REF: DX-____", description: "Find a booking by its reference number." },
      { label: "ROOM - NUMBER: ___", description: "Show room type, status and current booking." },
      { label: "ROOM TYPE - NAME: ___", description: "Show rooms and statuses for a room type." },
      { label: "FACILITY - NAME: ___", description: "Show facility status, hours and sales capability." },
      { label: "STAFF - NAME: ___", description: "Find a staff member (manager/owner only)." },
      { label: "ANALYTICS - TOPIC: ___", description: "Ask about occupancy, revenue, rates or bookings." },
      { label: "AVAILABILITY - ROOM TYPE: ___ - CHECK-IN: YYYY-MM-DD - CHECK-OUT: YYYY-MM-DD", description: "Find rooms free for exact dates." },
    ],
    note: "You can also type the question normally. The assistant tries a database-backed match first and uses Gemini only when the wording is ambiguous.",
  });
});

router.post("/ask", aiLimiter, scopeLocation, async (req, res, next) => {
  try {
    const { promptId, question, history } = req.body;

    if (promptId === "command_help") {
      return res.json({ answer: fallbackHelp(), mode: "template", contextUsed: null });
    }

    // Prepared prompts still work, but they now coexist with the database agent.
    if (promptId) {
      const prompt = promptById(promptId);
      if (!prompt) return res.status(404).json({ error: "That question is not one of the prepared ones." });
      if (!prompt.roles.includes(req.user.role)) {
        return res.status(403).json({ error: "Your role does not have access to that question." });
      }

      const result = await runPreparedPrompt(promptId, question || prompt.label, req.user, Array.isArray(history) ? history : []);
      if (!result.ok) return res.status(503).json({ error: result.text });
      logAction(req, { action: "Asked prepared assistant prompt: " + prompt.id, entity: "AI", location: req.location });
      return res.json({ answer: result.text, promptId, mode: result.mode || "database", contextUsed: prompt.context, context: result.data || null });
    }

    const result = await runAgent({
      question,
      user: req.user,
    });

    if (!result.ok) return res.status(400).json({ error: result.text });

    logAction(req, {
      action: "Asked hotel agent: " + String(question).slice(0, 100),
      entity: "AI",
      location: req.location,
    });

    res.json({
      answer: result.text,
      mode: result.mode || "database",
      action: result.action || null,
      data: result.data || null,
      contextUsed: null,
    });
  } catch (e) { next(e); }
});

module.exports = router;
