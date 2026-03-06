'use strict';

const { buildResponse } = require('../../shared/response');

/**
 * Lambda handler for health check endpoint.
 *
 * GET /api/health
 *
 * Returns service status and architecture info. Unlike the legacy health
 * check, this version reflects the serverless architecture capabilities.
 */
async function handler() {
  return buildResponse(200, {
    status: 'OK',
    service: 'MOTCO Notification Service',
    version: '2.0.0',
    architecture: 'AWS_SERVERLESS / LAMBDA / SNS_SQS / DYNAMODB',
    capabilities: [
      'Event persistence via DynamoDB with 90-day TTL',
      'Asynchronous fan-out via SNS topics',
      'Reliable delivery via SQS with retry and DLQ',
      'Independent function scaling and deployment',
      'Dead letter queue alerting via CloudWatch',
      'Infrastructure-as-code via CloudFormation',
    ],
    improvements: [
      'Replaced in-memory storage with DynamoDB persistence',
      'Replaced synchronous HTTP delivery with SNS/SQS pub/sub',
      'Added automatic retry with exponential backoff',
      'Added dead letter queues for failed delivery visibility',
      'Added CloudWatch alarms for operational monitoring',
      'Eliminated single point of failure',
    ],
  });
}

module.exports = { handler };
