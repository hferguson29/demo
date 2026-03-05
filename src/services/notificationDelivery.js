const http = require("http");
const { URL } = require("url");
const {
  NOTIFICATION_TYPES,
  SUBSCRIBER_ENDPOINTS,
} = require("../models/notificationTypes");
const { updateEventDelivery } = require("../models/eventStore");
const logger = require("../utils/logger");

/**
 * Deliver a notification event to all subscribed downstream systems.
 *
 * CRITICAL ARCHITECTURE PROBLEMS DEMONSTRATED HERE:
 *
 * 1. SYNCHRONOUS SEQUENTIAL DELIVERY: Each subscriber is called one after
 *    another. If GATES takes 5 seconds to respond, SMS, GTN, and everyone
 *    else waits. In a contested environment where networks are degraded,
 *    this means one slow consumer blocks the entire notification chain.
 *
 * 2. NO RETRY LOGIC: If a delivery fails (connection refused, timeout,
 *    HTTP error), the failure is logged and that's it. The notification
 *    is permanently lost for that subscriber. There is no retry queue,
 *    no exponential backoff, no dead letter handling.
 *
 * 3. NO FAN-OUT: Subscribers are hardcoded in notificationTypes.js.
 *    There's no pub/sub pattern. Adding a new consumer (e.g., a new
 *    analytics system) requires modifying code and redeploying.
 *
 * 4. FIRE AND FORGET ON FAILURE: The calling system (CMOS, RFID reader)
 *    gets a 200 OK as soon as the event is ingested, regardless of whether
 *    downstream delivery succeeds. There's no feedback mechanism.
 *
 * Migration target:
 * - SNS topic per notification type for fan-out
 * - SQS queues per subscriber with retry policies and DLQ
 * - Asynchronous, parallel delivery
 * - Automatic retry with exponential backoff
 * - Dead letter queue for permanently failed messages
 * - CloudWatch alerting on DLQ depth
 */

async function deliverToSubscriber(endpoint, payload, timeout) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);

    const postData = JSON.stringify(payload);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
        "X-Source-System": "MOTCO-NOTIFICATION-SERVICE",
        "X-Correlation-Id": payload.id,
      },
      timeout: timeout,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data });
        } else {
          reject(
            new Error(
              `HTTP ${res.statusCode} from ${url.hostname}:${url.port}`
            )
          );
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeout}ms to ${url.hostname}:${url.port}`));
    });

    req.on("error", (err) => {
      reject(
        new Error(`Connection failed to ${url.hostname}:${url.port}: ${err.message}`)
      );
    });

    req.write(postData);
    req.end();
  });
}

async function deliverEvent(event) {
  const typeConfig = NOTIFICATION_TYPES[event.type];
  if (!typeConfig) {
    logger.error(`Unknown notification type: ${event.type}`);
    return { success: false, error: "Unknown notification type" };
  }

  const subscribers = typeConfig.defaultSubscribers;
  const results = {};

  // PROBLEM: Sequential delivery — each subscriber blocks the next
  for (const subscriberId of subscribers) {
    const subscriber = SUBSCRIBER_ENDPOINTS[subscriberId];
    if (!subscriber) {
      logger.warn(`Unknown subscriber: ${subscriberId}`);
      results[subscriberId] = { status: "FAILED", error: "Unknown subscriber" };
      continue;
    }

    logger.info(
      `Delivering ${event.type} (TCN: ${event.tcn}) to ${subscriber.name}...`
    );

    try {
      await deliverToSubscriber(subscriber.endpoint, event, subscriber.timeout);
      results[subscriberId] = { status: "SUCCESS" };
      updateEventDelivery(event.id, subscriberId, "SUCCESS");
      logger.info(`  ✓ Delivered to ${subscriber.name}`);
    } catch (err) {
      // PROBLEM: No retry — failure is permanent
      results[subscriberId] = { status: "FAILED", error: err.message };
      updateEventDelivery(event.id, subscriberId, "FAILED", err);
      logger.error(`  ✗ Failed delivery to ${subscriber.name}: ${err.message}`);
    }
  }

  const totalSubscribers = subscribers.length;
  const successCount = Object.values(results).filter(
    (r) => r.status === "SUCCESS"
  ).length;
  const failCount = totalSubscribers - successCount;

  return {
    totalSubscribers,
    successCount,
    failCount,
    results,
    allDelivered: failCount === 0,
  };
}

/**
 * Retry delivery for a specific event to its failed subscribers.
 *
 * NOTE: This is a manual retry — someone has to notice the failure
 * and explicitly trigger this. In a contested environment at 0200,
 * that might not happen for hours. This is why automated retry with
 * exponential backoff (via SQS) is critical.
 */
async function retryFailedDeliveries(event) {
  if (!event.deliveryReport) {
    return { message: "No delivery report found" };
  }

  const failedSubscribers = Object.entries(event.deliveryReport)
    .filter(([_, report]) => report.status === "FAILED")
    .map(([subscriberId]) => subscriberId);

  if (failedSubscribers.length === 0) {
    return { message: "No failed deliveries to retry" };
  }

  const results = {};

  for (const subscriberId of failedSubscribers) {
    const subscriber = SUBSCRIBER_ENDPOINTS[subscriberId];
    if (!subscriber) continue;

    logger.info(`Retrying delivery to ${subscriber.name}...`);

    try {
      await deliverToSubscriber(subscriber.endpoint, event, subscriber.timeout);
      results[subscriberId] = { status: "SUCCESS" };
      updateEventDelivery(event.id, subscriberId, "SUCCESS");
    } catch (err) {
      results[subscriberId] = { status: "FAILED", error: err.message };
      updateEventDelivery(event.id, subscriberId, "FAILED", err);
    }
  }

  return { retriedSubscribers: failedSubscribers, results };
}

module.exports = { deliverEvent, retryFailedDeliveries };
