'use strict';

const { docClient, GetCommand, UpdateCommand } = require('../../shared/dynamodb');
const { publishToTopic } = require('../../shared/sns');
const { buildResponse } = require('../../shared/response');
const { getEventsTable, buildTopicArn } = require('../../shared/constants');

/**
 * Lambda handler for retrying failed event deliveries.
 *
 * Handles POST /api/events/:id/retry
 *
 * Retrieves the event from DynamoDB and republishes it to the appropriate
 * SNS topic. SQS subscribers will re-receive the event and attempt
 * delivery again, with their own retry policies and DLQ backoff.
 *
 * This replaces the legacy manual retry that attempted synchronous HTTP
 * calls to each failed subscriber one-by-one.
 */
async function handler(event) {
  try {
    const pathParameters = event.pathParameters || {};
    const eventId = pathParameters.id;

    if (!eventId) {
      return buildResponse(400, { error: 'Event ID is required' });
    }

    // Retrieve the event from DynamoDB
    const result = await docClient.send(
      new GetCommand({
        TableName: getEventsTable(),
        Key: { eventId },
      })
    );

    if (!result.Item) {
      return buildResponse(404, { error: 'Event not found' });
    }

    const eventRecord = result.Item;

    // Republish to SNS topic for redelivery
    const topicArn = buildTopicArn(eventRecord.type);
    const snsMessage = {
      id: eventRecord.eventId,
      type: eventRecord.type,
      tcn: eventRecord.tcn,
      sourceSystem: eventRecord.sourceSystem,
      sourceLocation: eventRecord.sourceLocation,
      priority: eventRecord.priority,
      payload: eventRecord.payload,
      createdAt: eventRecord.createdAt,
      isRetry: true,
      retryTimestamp: new Date().toISOString(),
    };

    await publishToTopic(topicArn, snsMessage);

    // Update event status in DynamoDB
    await docClient.send(
      new UpdateCommand({
        TableName: getEventsTable(),
        Key: { eventId },
        UpdateExpression: 'SET #status = :status, lastRetryAt = :retryAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'RETRIED',
          ':retryAt': new Date().toISOString(),
        },
      })
    );

    console.log(`Event ${eventId} (${eventRecord.type}) republished to SNS for retry`);

    return buildResponse(200, {
      eventId,
      type: eventRecord.type,
      message: 'Event republished to SNS for redelivery to all subscribers',
      retryTimestamp: snsMessage.retryTimestamp,
    });
  } catch (err) {
    console.error(`Error retrying event: ${err.message}`, err);
    return buildResponse(500, { error: 'Internal server error' });
  }
}

module.exports = { handler };
