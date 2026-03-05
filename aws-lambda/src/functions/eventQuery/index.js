'use strict';

const { docClient, GetCommand, QueryCommand, ScanCommand } = require('../../shared/dynamodb');
const { buildResponse } = require('../../shared/response');
const { getEventsTable, VALID_NOTIFICATION_TYPES } = require('../../shared/constants');

/**
 * Lambda handler for event queries.
 *
 * Handles:
 * - GET /api/events/:id — Retrieve a specific event by ID
 * - GET /api/events — List events with optional type filter and limit
 *
 * Replaces the legacy in-memory event store with DynamoDB queries.
 */
async function handler(event) {
  try {
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    const pathParameters = event.pathParameters || {};
    const queryStringParameters = event.queryStringParameters || {};

    // GET /api/events/:id
    if (pathParameters.id) {
      return await getEventById(pathParameters.id);
    }

    // GET /api/events
    return await listEvents(queryStringParameters);
  } catch (err) {
    console.error(`Error querying events: ${err.message}`, err);
    return buildResponse(500, { error: 'Internal server error' });
  }
}

/**
 * Retrieve a single event by its eventId.
 */
async function getEventById(eventId) {
  const result = await docClient.send(
    new GetCommand({
      TableName: getEventsTable(),
      Key: { eventId },
    })
  );

  if (!result.Item) {
    return buildResponse(404, { error: 'Event not found' });
  }

  // Map to legacy response format for API parity
  const item = result.Item;
  return buildResponse(200, {
    id: item.eventId,
    type: item.type,
    tcn: item.tcn,
    sourceSystem: item.sourceSystem,
    sourceLocation: item.sourceLocation,
    priority: item.priority,
    payload: item.payload,
    createdAt: item.createdAt,
    storedAt: item.createdAt,
    deliveryReport: item.deliveryReport || {},
    status: item.status,
  });
}

/**
 * List events with optional type filter and limit.
 * Uses GSI on type + createdAt for efficient filtered queries.
 */
async function listEvents(params) {
  const { type, limit } = params;
  const queryLimit = limit ? parseInt(limit, 10) : 50;

  let result;

  if (type) {
    // Validate type
    if (!VALID_NOTIFICATION_TYPES.includes(type)) {
      return buildResponse(400, {
        error: `Invalid notification type: ${type}`,
        validTypes: VALID_NOTIFICATION_TYPES,
      });
    }

    // Use GSI to query by type, sorted by createdAt descending
    result = await docClient.send(
      new QueryCommand({
        TableName: getEventsTable(),
        IndexName: 'type-createdAt-index',
        KeyConditionExpression: '#type = :type',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: { ':type': type },
        ScanIndexForward: false,
        Limit: queryLimit,
      })
    );
  } else {
    // No filter — scan (acceptable for small datasets, paginated)
    result = await docClient.send(
      new ScanCommand({
        TableName: getEventsTable(),
        Limit: queryLimit,
      })
    );

    // Sort by createdAt descending since Scan doesn't guarantee order
    if (result.Items) {
      result.Items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
  }

  const events = (result.Items || []).map((item) => ({
    id: item.eventId,
    type: item.type,
    tcn: item.tcn,
    sourceSystem: item.sourceSystem,
    sourceLocation: item.sourceLocation,
    priority: item.priority,
    payload: item.payload,
    createdAt: item.createdAt,
    storedAt: item.createdAt,
    deliveryReport: item.deliveryReport || {},
    status: item.status,
  }));

  return buildResponse(200, {
    count: events.length,
    events,
  });
}

module.exports = { handler };
