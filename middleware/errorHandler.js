// Errors explain what went wrong and what to do. They never leak stack traces
// or Mongo internals to the client.
function notFound(req, res) {
  res.status(404).json({ error: "That endpoint does not exist." });
}

function errorHandler(err, req, res, _next) {
  console.error("[error]", req.method, req.originalUrl, err.message);

  if (err.name === "ValidationError") {
    const field = Object.keys(err.errors)[0];
    return res.status(400).json({ error: err.errors[field].message, field });
  }
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || "value";
    return res.status(409).json({ error: "That " + field + " is already in use.", field });
  }
  if (err.name === "CastError") {
    return res.status(400).json({ error: "That record id is not valid." });
  }
  res.status(err.status || 500).json({ error: err.expose ? err.message : "Something went wrong on our side." });
}

module.exports = { notFound, errorHandler };
