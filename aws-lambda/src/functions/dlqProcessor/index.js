'use strict';

const { docClient, UpdateCommand } = require('../../shared/dynamodb');
const { getEventsTable } = require('../../shared/constants');

/**
 * Lambda handler for processing dead letter queue messages.
 *
 * This function is triggered by DLQ queues. Messages land here after
 * exhausting all retries (maxReceiveCount: 3) on the main SQS queue.
 *
 * Responsibilities:
 * 1. Log the permanently failed delivery with full context
 * 2. Update the event delivery report in DynamoDB with DEAD_LETTER status
 * 3. Metrics are emitted for CloudWatch alarms on DLQ depth
 *
 * This replaces the legacy "fire and forget" model where failed
 * deliveries were silently lost with no alerting.
 */
async function handler(event) {
  const results = [];

  for (const record of event.Records) {
    try {
      // Parse the message — may be wrapped in SNS → SQS format
      let eventData;
      try {
        const outerMessage = JSON.parse(record.body);
        const innerPayload = outerMessage.Message || outerMessage.body;
        eventData = innerPayload ? JSON.parse(innerPayload) : outerMessage;
      } catch (parseErr) {
        eventData = { id: 'unknown', type: 'unknown', tcn: 'unknown' };
        console.error(`Failed to parse DLQ message: ${parseErr.message}`);
      }

      const targetSystem = process.env.TARGET_SYSTEM || 'UNKNOWN';
      const receiveCount = record.attributes?.ApproximateReceiveCount || 'unknown';

      // Log the permanent failure with full context
      console.error(
        JSON.stringify({
          level: 'ERROR',
          message: 'PERMANENT DELIVERY FAILURE — Message moved to DLQ',
          eventId: eventData.id,
          eventType: eventData.type,
          tcn: eventData.tcn,
          targetSystem,
          sourceSystem: eventData.sourceSystem,
          receiveCount,
          messageId: record.messageId,
          sentTimestamp: record.attributes?.SentTimestamp,
          failureTimestamp: new Date().toISOString(),
          alert: 'Requires manual investigation and potential retry',
        })
      );

      // Update delivery report in DynamoDB
      if (eventData.id && eventData.id !== 'unknown') {
        await updateDeliveryAsDead(eventData.id, targetSystem, receiveCount);
      }

      results.push({
        messageId: record.messageId,
        eventId: eventData.id,
        targetSystem,
        status: 'LOGGED_TO_DLQ',
      });
    } catch (err) {
      console.error(`Error processing DLQ record ${record.messageId}: ${err.message}`);
      // Don't throw — we don't want DLQ messages going back to the queue
      results.push({
        messageId: record.messageId,
        status: 'PROCESSING_ERROR',
        error: err.message,
      });
    }
  }

  console.log(`DLQ Processor completed: ${results.length} messages processed`);
  return { results };
}

/**
 * Mark a delivery as permanently failed (dead letter) in DynamoDB.
 */
async function updateDeliveryAsDead(eventId, targetSystem, receiveCount) {
  try {
    const report = {
      status: 'DEAD_LETTER',
      timestamp: new Date().toISOString(),
      receiveCount,
      error: 'Message exhausted all retries and was moved to dead letter queue',
    };

    await docClient.send(
      new UpdateCommand({
        TableName: getEventsTable(),
        Key: { eventId },
        UpdateExpression: 'SET deliveryReport.#sub = :report, #status = :status',
        ExpressionAttributeNames: {
          '#sub': targetSystem,
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':report': report,
          ':status': 'PARTIALLY_FAILED',
        },
      })
    );
  } catch (err) {
    console.error(`Failed to update DLQ status for ${eventId}/${targetSystem}: ${err.message}`);
  }
}

module.exports = { handler };
