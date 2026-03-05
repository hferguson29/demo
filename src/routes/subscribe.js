const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { SUBSCRIBER_ENDPOINTS } = require("../models/notificationTypes");
const logger = require("../utils/logger");

const router = express.Router();

// Additional dynamic subscribers (beyond the hardcoded ones)
const dynamicSubscribers = new Map();

/**
 * POST /api/subscribe
 * Register a new downstream system as a notification subscriber.
 *
 * Body:
 * {
 *   "name": "New Analytics Platform",
 *   "endpoint": "http://10.0.5.42:8080/notifications",
 *   "eventTypes": ["SHIPMENT_DEPARTED", "DIVERSION_ALERT"],
 *   "timeout": 5000
 * }
 *
 * NOTE: Dynamic subscribers are stored in-memory. Server restart
 * loses all subscriptions. There is no subscription persistence,
 * no subscription discovery, and no way for subscribers to
 * self-register through a standard protocol.
 */
router.post("/", (req, res) => {
  const { name, endpoint, eventTypes, timeout } = req.body;

  if (!name || !endpoint) {
    return res.status(400).json({
      error: "name and endpoint are required",
    });
  }

  const subscriberId = uuidv4();
  dynamicSubscribers.set(subscriberId, {
    id: subscriberId,
    name,
    endpoint,
    eventTypes: eventTypes || [],
    timeout: timeout || 5000,
    registeredAt: new Date().toISOString(),
  });

  logger.info(`New subscriber registered: ${name} -> ${endpoint}`);

  res.status(201).json({
    subscriberId,
    name,
    endpoint,
    eventTypes,
    message: "Subscriber registered. NOTE: This registration is in-memory only and will be lost on server restart.",
  });
});

/**
 * DELETE /api/subscribe/:subscriberId
 * Remove a dynamic subscriber.
 */
router.delete("/:subscriberId", (req, res) => {
  const { subscriberId } = req.params;

  if (dynamicSubscribers.has(subscriberId)) {
    const sub = dynamicSubscribers.get(subscriberId);
    dynamicSubscribers.delete(subscriberId);
    logger.info(`Subscriber removed: ${sub.name}`);
    return res.json({ message: `Subscriber ${sub.name} removed` });
  }

  // Check if it's a hardcoded subscriber
  if (SUBSCRIBER_ENDPOINTS[subscriberId]) {
    return res.status(403).json({
      error: "Cannot remove hardcoded subscriber. Requires code change and redeployment.",
    });
  }

  res.status(404).json({ error: "Subscriber not found" });
});

/**
 * GET /api/subscribe
 * List all subscribers (hardcoded + dynamic).
 */
router.get("/", (req, res) => {
  const hardcoded = Object.entries(SUBSCRIBER_ENDPOINTS).map(
    ([id, config]) => ({
      id,
      ...config,
      type: "HARDCODED",
      note: "Requires code change to modify",
    })
  );

  const dynamic = Array.from(dynamicSubscribers.values()).map((sub) => ({
    ...sub,
    type: "DYNAMIC",
    note: "In-memory only — lost on restart",
  }));

  res.json({
    hardcodedCount: hardcoded.length,
    dynamicCount: dynamic.length,
    subscribers: [...hardcoded, ...dynamic],
  });
});

module.exports = router;
