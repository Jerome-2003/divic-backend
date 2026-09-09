require("dotenv").config();

const dns = require("dns");
// Windows can hand Node a resolver from a stale or virtual network adapter,
// which refuses the SRV lookup that mongodb+srv:// depends on.
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const { connectDB } = require("./config/db");
const { notFound, errorHandler } = require("./middleware/errorHandler");

const app = express();
const server = http.createServer(app);

// Three apps talk to this API: the staff PMS, the public website, and local
// development. CLIENT_ORIGIN accepts a comma-separated list so the PMS can be
// served from more than one place (a desktop build and a web route) without
// needing another environment variable each time.
// Trailing slashes are the single most common way this list silently stops
// matching: a browser's Origin header never has one, but it's easy to paste
// "https://divic-frontend.onrender.com/" into Render's env var UI and not
// notice. Strip them here so a stray slash doesn't reintroduce this bug.
const allowedOrigins = [
  ...String(process.env.CLIENT_ORIGIN || "").split(",").map((s) => s.trim()),
  ...String(process.env.WEBSITE_ORIGIN || "").split(",").map((s) => s.trim()),
  "http://localhost:5173",
  "http://localhost:5174",
]
  .filter(Boolean)
  .map((o) => o.replace(/\/+$/, ""));

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin.replace(/\/+$/, ""))) return cb(null, true);
    console.warn("[cors] blocked origin:", origin, "allowed:", allowedOrigins);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));
// Mounted BEFORE express.json: the Paystack signature is an HMAC of the raw
// bytes, and a parsed-then-restringified body will not match it.
app.use("/api/webhooks", require("./routes/webhook.routes"));

app.use(express.json({ limit: "12mb" }));
app.set("trust proxy", 1);

// Real-time sync. Staff join a room per property so a change at Divic Urban
// never appears on a screen at Divic Exclusive.
const io = new Server(server, { cors: { origin: allowedOrigins, credentials: true } });
io.on("connection", (socket) => {
  socket.on("join", (location) => {
    if (["exclusive", "urban"].includes(location)) socket.join("loc:" + location);
  });
});
app.set("io", io);

app.get("/health", (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));

app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/rooms", require("./routes/rooms.routes"));
app.use("/api/bookings", require("./routes/bookings.routes"));
app.use("/api/requests", require("./routes/requests.routes"));
app.use("/api/guests", require("./routes/guests.routes"));
app.use("/api/payments", require("./routes/payments.routes"));
app.use("/api/facilities", require("./routes/facilities.routes"));
app.use("/api/staff", require("./routes/staff.routes"));
app.use("/api/analytics", require("./routes/analytics.routes"));
app.use("/api/audit", require("./routes/audit.routes"));
app.use("/api/ai", require("./routes/ai.routes"));
app.use("/api/notifications", require("./routes/notifications.routes"));
app.use("/api/content", require("./routes/content.routes"));
app.use("/api/todos", require("./routes/todos.routes"));
app.use("/api/public", require("./routes/public.routes"));

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

async function start() {
  await connectDB(process.env.MONGO_URI);
  // 0.0.0.0 matters on Render: binding to localhost means the port scanner
  // cannot see the service and the deploy fails with "no open ports detected".
  server.listen(PORT, "0.0.0.0", () => console.log("[server] listening on " + PORT));
}

start().catch((err) => {
  console.error("[fatal] failed to start server", err);
  process.exit(1);
});