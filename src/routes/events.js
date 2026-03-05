const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { NOTIFICATION_TYPES } = require("../models/notificationTypes");
const {
  storeEvent,
  getEvent,
  listEvents,
} = require("../models/eventStore");
const {
  deliverEvent,
  retryFailedDeliveries,
} = require("../services/notificationDelivery");
const logger = require("../utils/logger");

const router = express.Router();

/**
 * POST /api/events
 *
 * Ingest a new shipment event from a source system (CMOS, RFID reader, etc.)
 *
 * Expected body:
 * {
 *   "type": "MANIFEST_READY",
 *   "tcn": "W25K1A0456789XA",        // Transportation Control Number
 *   "sourceSystem": "CMOS",
 *   "sourceLocation": "MOTCO",
 *   "payload": {
 *     "vesselName": "USNS Watkins",
 *     "voyageNumber": "V2026-0312",
 *     "cargoType": "AMMUNITION",
 *     "containerCount": 48,
 *     "hazmatClass": "1.1",
 *     "destinationPort": "APRA_HARBOR_GUAM",
 *     "estimatedDeparture": "2026-03-10T0800Z"
 *   }
 * }
 */
router.post("/", async (req, res) => {
  try {
    const { type, tcn, sourceSystem, sourceLocation, payload } = req.body;

    // Validate notification type
    if (!type || !NOTIFICATION_TYPES[type]) {
      return res.status(400).json({
        error: "Invalid notification type",
        validTypes: Object.keys(NOTIFICATION_TYPES),
      });
    }

    if (!tcn) {
      return res.status(400).json({
        error: "Transportation Control Number (tcn) is required",
      });
    }

    // Build the event
    const event = {
      id: uuidv4(),
      type,
      tcn,
      sourceSystem: sourceSystem || "UNKNOWN",
      sourceLocation: sourceLocation || "UNKNOWN",
      priority: NOTIFICATION_TYPES[type].priority,
      payload: payload || {},
      createdAt: new Date().toISOString(),
      deliveryReport: {},
    };

    // Store the event (in-memory only — lost on restart)
    storeEvent(event);
    logger.info(
      `Event ingested: ${type} | TCN: ${tcn} | Source: ${sourceSystem}@${sourceLocation}`
    );

    // Deliver to subscribers (synchronous, blocking, no retry)
    const deliveryResult = await deliverEvent(event);

    // NOTE: We return 200 even if some deliveries failed.
    // The source system has no way to know that GATES or SMS
    // didn't receive the notification.
    res.status(201).json({
      id: event.id,
      type: event.type,
      tcn: event.tcn,
      priority: event.priority,
      createdAt: event.createdAt,
      delivery: deliveryResult,
    });
  } catch (err) {
    logger.error(`Error processing event: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/events/:id
 * Retrieve a specific event with its delivery report.
 */
router.get("/:id", (req, res) => {
  const event = getEvent(req.params.id);
  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }
  res.json(event);
});

/**
 * GET /api/events
 * List recent events, optionally filtered by type.
 * Query params: ?type=MANIFEST_READY&limit=20
 */
router.get("/", (req, res) => {
  const { type, limit } = req.query;
  const events = listEvents({
    type,
    limit: limit ? parseInt(limit, 10) : 50,
  });
  res.json({
    count: events.length,
    events,
  });
});

/**
 * POST /api/events/:id/retry
 * Manually retry failed deliveries for a specific event.
 *
 * This is the only recovery mechanism available in the current architecture.
 * If nobody checks delivery reports and triggers retries, failed notifications
 * are permanently lost. At 0200 in a contested environment, that's a problem.
 */
router.post("/:id/retry", async (req, res) => {
  const event = getEvent(req.params.id);
  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }

  logger.info(`Manual retry requested for event ${event.id} (${event.type})`);
  const result = await retryFailedDeliveries(event);

  res.json({
    eventId: event.id,
    ...result,
  });
});

module.exports = router;
