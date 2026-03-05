'use strict';

const { v4: uuidv4 } = require('uuid');
const { docClient, PutCommand } = require('../../shared/dynamodb');
const { publishToTopic } = require('../../shared/sns');
const { validateEvent } = require('../../shared/validation');
const { buildResponse } = require('../../shared/response');
const {
  NOTIFICATION_TYPES,
  getEventsTable,
  getSnsTopicArnPrefix,
  EVENT_TTL_SECONDS,
} = require('../../shared/constants');

/**
 * Lambda handler for event ingestion.
 *
 * Receives POST /api/events from API Gateway, validates the payload,
 * stores the event in DynamoDB, and publishes to the appropriate SNS topic
 * for fan-out to downstream subscribers.
 *
 * Replaces the legacy synchronous delivery model with async pub/sub.
 */
async function handler(event) {
  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;

    // Validate incoming event
    const validation = validateEvent(body);
    if (!validation.valid) {
      return buildResponse(400, {
        error: 'Validation failed',
        details: validation.errors,
        validTypes: Object.keys(NOTIFICATION_TYPES),
      });
    }

    const { type, tcn, sourceSystem, sourceLocation, payload } = body;
    const now = new Date();
    const eventId = uuidv4();

    // Build the event record
    const eventRecord = {
      eventId,
      type,
      tcn,
      sourceSystem: sourceSystem || 'UNKNOWN',
      sourceLocation: sourceLocation || 'UNKNOWN',
      priority: NOTIFICATION_TYPES[type].priority,
      payload: payload || {},
      createdAt: now.toISOString(),
      status: 'PUBLISHED',
      deliveryReport: {},
      ttl: Math.floor(now.getTime() / 1000) + EVENT_TTL_SECONDS,
    };

    // Store in DynamoDB
    await docClient.send(
      new PutCommand({
        TableName: getEventsTable(),
        Item: eventRecord,
      })
    );

    // Publish to SNS topic for fan-out
    const topicArn = `${getSnsTopicArnPrefix()}${type}`;
    const snsMessage = {
      id: eventId,
      type,
      tcn,
      sourceSystem: eventRecord.sourceSystem,
      sourceLocation: eventRecord.sourceLocation,
      priority: eventRecord.priority,
      payload: eventRecord.payload,
      createdAt: eventRecord.createdAt,
    };

    await publishToTopic(topicArn, snsMessage);

    console.log(
      `Event ingested: ${type} | TCN: ${tcn} | ID: ${eventId} | Source: ${eventRecord.sourceSystem}@${eventRecord.sourceLocation}`
    );

    return buildResponse(201, {
      id: eventId,
      type,
      tcn,
      priority: eventRecord.priority,
      createdAt: eventRecord.createdAt,
      status: 'PUBLISHED',
      message: 'Event published to SNS for async delivery to subscribers',
    });
  } catch (err) {
    console.error(`Error processing event: ${err.message}`, err);
    return buildResponse(500, { error: 'Internal server error' });
  }
}

module.exports = { handler };
