/**
 * Notification types corresponding to JDDE shipment lifecycle events.
 * Each type defines which downstream systems should receive the notification.
 *
 * In this legacy architecture, subscribers are hardcoded per event type.
 * This is one of the key problems: adding a new consumer requires a code
 * change and redeployment, rather than a simple subscription.
 */

const NOTIFICATION_TYPES = {
  MANIFEST_READY: {
    description: "CMOS has completed cargo manifest for a vessel load",
    priority: "HIGH",
    defaultSubscribers: ["GATES", "ICODES", "SMS"],
  },
  SHIPMENT_DEPARTED: {
    description: "Vessel has departed port with cargo",
    priority: "HIGH",
    defaultSubscribers: ["DTTS", "GTN", "SMS"],
  },
  SHIPMENT_DELAYED: {
    description: "Delay detected — weather, mechanical, port congestion, or contested conditions",
    priority: "CRITICAL",
    defaultSubscribers: ["SMS", "PLANNING_SYSTEMS"],
  },
  RFID_SCAN_EVENT: {
    description: "RFID interrogator has read a tag at a checkpoint",
    priority: "NORMAL",
    defaultSubscribers: ["RF_ITV", "GTN"],
  },
  SUSTAINMENT_REQUEST: {
    description: "Forward-deployed unit has requested resupply",
    priority: "HIGH",
    defaultSubscribers: ["CMOS", "PLANNING_SYSTEMS"],
  },
  DIVERSION_ALERT: {
    description: "Shipment rerouted due to contested port, threat, or priority change",
    priority: "CRITICAL",
    defaultSubscribers: ["GATES", "SMS", "GTN", "PLANNING_SYSTEMS", "DTTS"],
  },
};

/**
 * Simulated downstream system endpoints.
 * In the real Distributed Enclave, these would be actual internal URLs
 * to GATES, SMS, GTN, etc. Here we simulate them as localhost endpoints
 * that may or may not be reachable (to demonstrate the failure modes).
 */
const SUBSCRIBER_ENDPOINTS = {
  GATES: {
    name: "Global Air Transportation Execution System",
    endpoint: "http://localhost:4001/ingest",
    timeout: 5000,
  },
  ICODES: {
    name: "Integrated Computerized Deployment System",
    endpoint: "http://localhost:4002/ingest",
    timeout: 5000,
  },
  SMS: {
    name: "Single Mobility System",
    endpoint: "http://localhost:4003/ingest",
    timeout: 5000,
  },
  DTTS: {
    name: "Defense Transportation Tracking System",
    endpoint: "http://localhost:4004/ingest",
    timeout: 5000,
  },
  GTN: {
    name: "Global Transportation Network",
    endpoint: "http://localhost:4005/ingest",
    timeout: 5000,
  },
  RF_ITV: {
    name: "Radio Frequency In-Transit Visibility System",
    endpoint: "http://localhost:4006/ingest",
    timeout: 5000,
  },
  CMOS: {
    name: "Cargo Movement Operations System",
    endpoint: "http://localhost:4007/ingest",
    timeout: 5000,
  },
  PLANNING_SYSTEMS: {
    name: "Theater Planning Systems",
    endpoint: "http://localhost:4008/ingest",
    timeout: 5000,
  },
};

module.exports = { NOTIFICATION_TYPES, SUBSCRIBER_ENDPOINTS };
