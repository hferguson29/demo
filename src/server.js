const express = require("express");
const logger = require("./utils/logger");
const { getEventCount } = require("./models/eventStore");

const eventsRouter = require("./routes/events");
const subscribeRouter = require("./routes/subscribe");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Routes
app.use("/api/events", eventsRouter);
app.use("/api/subscribe", subscribeRouter);

/**
 * GET /api/health
 * Health check endpoint.
 *
 * NOTE: This is a basic health check that only confirms the process
 * is running. It does not check connectivity to downstream systems,
 * does not verify the notification delivery pipeline is working,
 * and does not detect partial failures. A more robust health check
 * would verify connectivity to each subscriber endpoint.
 */
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    service: "MOTCO Notification Service",
    version: "1.0.0",
    uptime: process.uptime(),
    eventsInMemory: getEventCount(),
    architecture: "ON-PREMISE / SINGLE INSTANCE / IN-MEMORY",
    warnings: [
      "No event persistence — data lost on restart",
      "No delivery retry — failed notifications are permanent",
      "No horizontal scaling — single instance only",
      "No dead letter queue — no visibility into failed deliveries",
    ],
  });
});

// Root
app.get("/", (req, res) => {
  res.json({
    service: "MOTCO Notification Service",
    description:
      "On-premise notification service for JDDE movement coordination",
    endpoints: {
      health: "GET /api/health",
      ingestEvent: "POST /api/events",
      getEvent: "GET /api/events/:id",
      listEvents: "GET /api/events?type=MANIFEST_READY&limit=20",
      retryEvent: "POST /api/events/:id/retry",
      subscribe: "POST /api/subscribe",
      unsubscribe: "DELETE /api/subscribe/:id",
      listSubscribers: "GET /api/subscribe",
    },
  });
});

// Start server
app.listen(PORT, () => {
  logger.info("==============================================");
  logger.info("  MOTCO NOTIFICATION SERVICE");
  logger.info("  On-Premise Legacy Architecture");
  logger.info(`  Running on port ${PORT}`);
  logger.info("  WARNING: In-memory storage only");
  logger.info("  WARNING: No delivery retry mechanism");
  logger.info("  WARNING: Single instance — no failover");
  logger.info("==============================================");
});

module.exports = app;
