/**
 * In-memory event store.
 *
 * THIS IS ONE OF THE KEY VULNERABILITIES of the on-premise architecture:
 * - All events are stored in memory only
 * - Server restart loses all event history
 * - No persistence, no recovery, no audit trail
 * - Cannot scale horizontally (each instance has its own memory)
 *
 * Migration target: DynamoDB table with TTL for automatic cleanup,
 * point-in-time recovery, and global table replication for DDIL scenarios.
 */

const events = new Map();

function storeEvent(event) {
  events.set(event.id, {
    ...event,
    storedAt: new Date().toISOString(),
  });
}

function getEvent(id) {
  return events.get(id) || null;
}

function listEvents({ type, limit = 50 } = {}) {
  let results = Array.from(events.values());

  if (type) {
    results = results.filter((e) => e.type === type);
  }

  // Sort by creation time descending
  results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return results.slice(0, limit);
}

function updateEventDelivery(eventId, subscriberId, status, error = null) {
  const event = events.get(eventId);
  if (!event) return null;

  if (!event.deliveryReport) {
    event.deliveryReport = {};
  }

  event.deliveryReport[subscriberId] = {
    status, // 'SUCCESS', 'FAILED', 'PENDING'
    timestamp: new Date().toISOString(),
    error: error ? error.message || String(error) : null,
    attempts: (event.deliveryReport[subscriberId]?.attempts || 0) + 1,
  };

  events.set(eventId, event);
  return event;
}

function getEventCount() {
  return events.size;
}

module.exports = {
  storeEvent,
  getEvent,
  listEvents,
  updateEventDelivery,
  getEventCount,
};
