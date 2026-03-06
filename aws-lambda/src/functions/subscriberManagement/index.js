'use strict';

const { v4: uuidv4 } = require('uuid');
const {
  docClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
  ScanCommand,
} = require('../../shared/dynamodb');
const { validateSubscriber } = require('../../shared/validation');
const { buildResponse } = require('../../shared/response');
const { getSubscribersTable, DOWNSTREAM_SYSTEMS } = require('../../shared/constants');

/**
 * Lambda handler for subscriber management.
 *
 * Handles:
 * - POST /api/subscribe — Register a new subscriber (stored in DynamoDB)
 * - DELETE /api/subscribe/:subscriberId — Remove a subscriber
 * - GET /api/subscribe — List all subscribers
 *
 * Replaces the legacy in-memory subscriber map and hardcoded endpoint list.
 * Subscribers are now persisted in DynamoDB and can dynamically register
 * to receive events via SNS/SQS without code changes.
 */
async function handler(event) {
  try {
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    const pathParameters = event.pathParameters || {};

    switch (httpMethod) {
      case 'POST':
        return await createSubscriber(event);
      case 'DELETE':
        return await deleteSubscriber(pathParameters.subscriberId);
      case 'GET':
        return await listSubscribers();
      default:
        return buildResponse(405, { error: `Method ${httpMethod} not allowed` });
    }
  } catch (err) {
    console.error(`Error in subscriber management: ${err.message}`, err);
    return buildResponse(500, { error: 'Internal server error' });
  }
}

/**
 * Register a new subscriber.
 */
async function createSubscriber(event) {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;

  const validation = validateSubscriber(body);
  if (!validation.valid) {
    return buildResponse(400, {
      error: 'Validation failed',
      details: validation.errors,
    });
  }

  const { name, endpoint, eventTypes, timeout } = body;
  const subscriberId = uuidv4();

  const subscriber = {
    subscriberId,
    name,
    endpoint,
    eventTypes: eventTypes || [],
    timeout: timeout || 5000,
    registeredAt: new Date().toISOString(),
    type: 'DYNAMIC',
  };

  await docClient.send(
    new PutCommand({
      TableName: getSubscribersTable(),
      Item: subscriber,
    })
  );

  console.log(`New subscriber registered: ${name} -> ${endpoint}`);

  return buildResponse(201, {
    subscriberId,
    name,
    endpoint,
    eventTypes: subscriber.eventTypes,
    message: 'Subscriber registered and persisted in DynamoDB',
  });
}

/**
 * Delete a subscriber by ID.
 */
async function deleteSubscriber(subscriberId) {
  if (!subscriberId) {
    return buildResponse(400, { error: 'subscriberId is required' });
  }

  // Check if it's a built-in downstream system name
  if (DOWNSTREAM_SYSTEMS[subscriberId]) {
    return buildResponse(403, {
      error: 'Cannot remove built-in downstream system subscriber. Use SQS queue management instead.',
    });
  }

  // Check if subscriber exists
  const result = await docClient.send(
    new GetCommand({
      TableName: getSubscribersTable(),
      Key: { subscriberId },
    })
  );

  if (!result.Item) {
    return buildResponse(404, { error: 'Subscriber not found' });
  }

  const subscriberName = result.Item.name;

  await docClient.send(
    new DeleteCommand({
      TableName: getSubscribersTable(),
      Key: { subscriberId },
    })
  );

  console.log(`Subscriber removed: ${subscriberName}`);

  return buildResponse(200, {
    message: `Subscriber ${subscriberName} removed`,
  });
}

/**
 * List all subscribers (built-in systems + dynamic DynamoDB subscribers).
 */
async function listSubscribers() {
  // Built-in downstream systems (managed via CloudFormation SQS queues)
  const builtIn = Object.entries(DOWNSTREAM_SYSTEMS).map(([id, config]) => ({
    id,
    name: config.name,
    type: 'BUILT_IN',
    note: 'Managed via SQS queue subscription to SNS topics',
  }));

  // Dynamic subscribers from DynamoDB
  const result = await docClient.send(
    new ScanCommand({
      TableName: getSubscribersTable(),
    })
  );

  const dynamic = (result.Items || []).map((item) => ({
    id: item.subscriberId,
    name: item.name,
    endpoint: item.endpoint,
    eventTypes: item.eventTypes,
    timeout: item.timeout,
    registeredAt: item.registeredAt,
    type: 'DYNAMIC',
    note: 'Persisted in DynamoDB',
  }));

  return buildResponse(200, {
    builtInCount: builtIn.length,
    dynamicCount: dynamic.length,
    subscribers: [...builtIn, ...dynamic],
  });
}

module.exports = { handler };
