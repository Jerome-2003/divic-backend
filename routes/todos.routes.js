const router = require("express").Router();
const Todo = require("../models/Todo");
const { requireAuth, scopeLocation } = require("../middleware/auth");

router.use(requireAuth, scopeLocation);

router.get("/", async (req, res, next) => {
  try {
    const rows = await Todo.find({ location: req.location })
      .populate("createdBy", "name")
      .populate("completedBy", "name")
      .sort({ completed: 1, createdAt: -1 }).limit(200).lean();
    res.json(rows);
  } catch (e) { next(e); }
});

router.post("/", async (req, res, next) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Write something for the to-do item." });
    const todo = await Todo.create({ text: text.slice(0, 300), location: req.location, createdBy: req.user.id });
    await todo.populate("createdBy", "name");
    req.app.get("io")?.to("loc:" + req.location).emit("todo:updated", todo);
    res.status(201).json(todo);
  } catch (e) { next(e); }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const todo = await Todo.findById(req.params.id);
    if (!todo) return res.status(404).json({ error: "That to-do item does not exist." });
    if (todo.location !== req.location) return res.status(403).json({ error: "You can only work on this property's to-do list." });
    if (req.body.text !== undefined) {
      const text = String(req.body.text).trim();
      if (!text) return res.status(400).json({ error: "A to-do item cannot be empty." });
      todo.text = text.slice(0, 300);
    }
    if (req.body.completed !== undefined) {
      todo.completed = Boolean(req.body.completed);
      todo.completedBy = todo.completed ? req.user.id : undefined;
      todo.completedAt = todo.completed ? new Date() : undefined;
    }
    await todo.save();
    await todo.populate("createdBy", "name");
    await todo.populate("completedBy", "name");
    req.app.get("io")?.to("loc:" + req.location).emit("todo:updated", todo);
    res.json(todo);
  } catch (e) { next(e); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const todo = await Todo.findById(req.params.id);
    if (!todo) return res.status(404).json({ error: "That to-do item does not exist." });
    if (todo.location !== req.location) return res.status(403).json({ error: "You can only work on this property's to-do list." });
    await todo.deleteOne();
    req.app.get("io")?.to("loc:" + req.location).emit("todo:updated", { _id: todo._id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
