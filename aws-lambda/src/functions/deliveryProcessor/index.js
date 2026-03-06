'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { docClient, UpdateCommand } = require('../../shared/dynamodb');
const { getEventsTable } = require('../../shared/constants');

/**
 * Lambda handler for processing SQS messages and delivering to downstream systems.
 *
 * This function is triggered by SQS queues (one per downstream system).
 * Each queue is subscribed to the relevant SNS topics.
 *
 * The SQS retry policy (maxReceiveCount: 3) with exponential backoff
 * provides automatic retries. Messages that fail all retries are moved
 * to the dead letter queue.
 *
 * This replaces the legacy synchronous, sequential, fire-and-forget delivery.
 */
async function handler(event) {
  const results = [];

  for (const record of event.Records) {
    try {
      // Parse the SNS message wrapped in SQS
      const snsMessage = JSON.parse(record.body);
      const innerPayload = snsMessage.Message || snsMessage.body;
      const eventData = innerPayload ? JSON.parse(innerPayload) : snsMessage;

      // The target system is determined by the queue that triggered this Lambda
      // (configured via environment variable)
      const targetSystem = process.env.TARGET_SYSTEM || 'UNKNOWN';
      const targetEndpoint = process.env.TARGET_ENDPOINT;

      console.log(
        `Processing delivery: ${eventData.type} (TCN: ${eventData.tcn}) -> ${targetSystem}`
      );

      if (targetEndpoint) {
        await deliverToEndpoint(targetEndpoint, eventData);
      }

      // Update delivery report in DynamoDB
      if (eventData.id) {
        await updateDeliveryStatus(eventData.id, targetSystem, 'SUCCESS');
      }

      console.log(`Delivered ${eventData.type} to ${targetSystem} successfully`);
      results.push({ recordId: record.messageId, status: 'SUCCESS' });
    } catch (err) {
      console.error(`Failed to process record ${record.messageId}: ${err.message}`);

      // Update delivery status to FAILED
      try {
        const snsMessage = JSON.parse(record.body);
        const innerPayload = snsMessage.Message || snsMessage.body;
        const eventData = innerPayload ? JSON.parse(innerPayload) : snsMessage;
        const targetSystem = process.env.TARGET_SYSTEM || 'UNKNOWN';

        if (eventData.id) {
          await updateDeliveryStatus(eventData.id, targetSystem, 'FAILED', err.message);
        }
      } catch (updateErr) {
        console.error(`Failed to update delivery status: ${updateErr.message}`);
      }

      // Throw to let SQS retry (message becomes visible again after visibility timeout)
      throw err;
    }
  }

  return { results };
}

/**
 * Deliver event data to a downstream system endpoint via HTTP POST.
 */
async function deliverToEndpoint(endpoint, eventData) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const postData = JSON.stringify(eventData);
    const transport = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'X-Source-System': 'MOTCO-NOTIFICATION-SERVICE',
        'X-Correlation-Id': eventData.id || 'unknown',
      },
      timeout: parseInt(process.env.DELIVERY_TIMEOUT || '30000', 10),
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data });
        } else {
          reject(new Error(`HTTP ${res.statusCode} from ${url.hostname}:${url.port}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout delivering to ${url.hostname}:${url.port}`));
    });

    req.on('error', (err) => {
      reject(new Error(`Connection failed to ${url.hostname}: ${err.message}`));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Update the delivery report for an event in DynamoDB.
 */
async function updateDeliveryStatus(eventId, subscriberId, status, error) {
  try {
    const updateExpression = `SET deliveryReport.#sub = :report`;
    const report = {
      status,
      timestamp: new Date().toISOString(),
      error: error || null,
    };

    await docClient.send(
      new UpdateCommand({
        TableName: getEventsTable(),
        Key: { eventId },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: { '#sub': subscriberId },
        ExpressionAttributeValues: { ':report': report },
      })
    );
  } catch (err) {
    console.error(`Failed to update delivery status for ${eventId}/${subscriberId}: ${err.message}`);
  }
}

module.exports = { handler };
