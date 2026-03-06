'use strict';

/**
 * Notification types corresponding to JDDE shipment lifecycle events.
 * These map 1:1 to SNS topics in the serverless architecture.
 */
const NOTIFICATION_TYPES = {
  MANIFEST_READY: {
    description: 'CMOS has completed cargo manifest for a vessel load',
    priority: 'HIGH',
  },
  SHIPMENT_DEPARTED: {
    description: 'Vessel has departed port with cargo',
    priority: 'HIGH',
  },
  SHIPMENT_DELAYED: {
    description: 'Delay detected — weather, mechanical, port congestion, or contested conditions',
    priority: 'CRITICAL',
  },
  RFID_SCAN_EVENT: {
    description: 'RFID interrogator has read a tag at a checkpoint',
    priority: 'NORMAL',
  },
  SUSTAINMENT_REQUEST: {
    description: 'Forward-deployed unit has requested resupply',
    priority: 'HIGH',
  },
  DIVERSION_ALERT: {
    description: 'Shipment rerouted due to contested port, threat, or priority change',
    priority: 'CRITICAL',
  },
};

const VALID_NOTIFICATION_TYPES = Object.keys(NOTIFICATION_TYPES);

/**
 * Downstream systems that subscribe to notification topics.
 * In the serverless architecture, each has its own SQS queue.
 */
const DOWNSTREAM_SYSTEMS = {
  GATES: { name: 'Global Air Transportation Execution System' },
  ICODES: { name: 'Integrated Computerized Deployment System' },
  SMS: { name: 'Single Mobility System' },
  DTTS: { name: 'Defense Transportation Tracking System' },
  GTN: { name: 'Global Transportation Network' },
  RF_ITV: { name: 'Radio Frequency In-Transit Visibility System' },
  CMOS: { name: 'Cargo Movement Operations System' },
  PLANNING_SYSTEMS: { name: 'Theater Planning Systems' },
};

/**
 * Default topic-to-subscriber mappings.
 * These define which SQS queues subscribe to which SNS topics.
 */
const DEFAULT_TOPIC_SUBSCRIPTIONS = {
  MANIFEST_READY: ['GATES', 'ICODES', 'SMS'],
  SHIPMENT_DEPARTED: ['DTTS', 'GTN', 'SMS'],
  SHIPMENT_DELAYED: ['SMS', 'PLANNING_SYSTEMS'],
  RFID_SCAN_EVENT: ['RF_ITV', 'GTN'],
  SUSTAINMENT_REQUEST: ['CMOS', 'PLANNING_SYSTEMS'],
  DIVERSION_ALERT: ['GATES', 'SMS', 'GTN', 'PLANNING_SYSTEMS', 'DTTS'],
};

/** TTL duration: 90 days in seconds */
const EVENT_TTL_SECONDS = 90 * 24 * 60 * 60;

/** DynamoDB table names (read at runtime via getter for testability) */
function getEventsTable() {
  return process.env.EVENTS_TABLE || 'MotcoEvents';
}

function getSubscribersTable() {
  return process.env.SUBSCRIBERS_TABLE || 'MotcoSubscribers';
}

/** SNS topic ARN prefix (read at runtime via getter for testability) */
function getSnsTopicArnPrefix() {
  return process.env.SNS_TOPIC_ARN_PREFIX || '';
}

/** Environment name (read at runtime) */
function getEnvironment() {
  return process.env.ENVIRONMENT || 'dev';
}

/**
 * Build the full SNS topic ARN for a given notification type.
 * Topic naming convention: motco-{TYPE}-{ENVIRONMENT}
 * e.g. arn:aws:sns:us-east-1:123456789:motco-MANIFEST_READY-dev
 */
function buildTopicArn(notificationType) {
  return `${getSnsTopicArnPrefix()}${notificationType}-${getEnvironment()}`;
}

module.exports = {
  NOTIFICATION_TYPES,
  VALID_NOTIFICATION_TYPES,
  DOWNSTREAM_SYSTEMS,
  DEFAULT_TOPIC_SUBSCRIPTIONS,
  EVENT_TTL_SECONDS,
  getEventsTable,
  getSubscribersTable,
  getSnsTopicArnPrefix,
  getEnvironment,
  buildTopicArn,
};
