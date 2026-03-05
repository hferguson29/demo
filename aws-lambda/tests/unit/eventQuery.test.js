'use strict';

const { handler } = require('../../src/functions/eventQuery/index');

// Mock DynamoDB
jest.mock('../../src/shared/dynamodb', () => {
  const mockSend = jest.fn();
  return {
    docClient: { send: mockSend },
    PutCommand: jest.fn(),
    GetCommand: jest.fn().mockImplementation((params) => params),
    QueryCommand: jest.fn().mockImplementation((params) => params),
    DeleteCommand: jest.fn(),
    UpdateCommand: jest.fn(),
    ScanCommand: jest.fn().mockImplementation((params) => params),
  };
});

const { docClient } = require('../../src/shared/dynamodb');

describe('eventQuery Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVENTS_TABLE = 'test-events-table';
  });

  describe('GET /api/events/:id', () => {
    test('should return event by ID', async () => {
      docClient.send.mockResolvedValueOnce({
        Item: {
          eventId: 'evt-123',
          type: 'MANIFEST_READY',
          tcn: 'W25K1A0456789XA',
          sourceSystem: 'CMOS',
          sourceLocation: 'MOTCO',
          priority: 'HIGH',
          payload: { vesselName: 'USNS Watkins' },
          createdAt: '2026-03-10T08:00:00Z',
          status: 'PUBLISHED',
          deliveryReport: {},
        },
      });

      const event = {
        pathParameters: { id: 'evt-123' },
        queryStringParameters: {},
      };

      const result = await handler(event);
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(200);
      expect(body.id).toBe('evt-123');
      expect(body.type).toBe('MANIFEST_READY');
      expect(body.tcn).toBe('W25K1A0456789XA');
      expect(body.sourceSystem).toBe('CMOS');
      expect(body.payload.vesselName).toBe('USNS Watkins');
    });

    test('should return 404 for non-existent event', async () => {
      docClient.send.mockResolvedValueOnce({ Item: null });

      const event = {
        pathParameters: { id: 'non-existent' },
        queryStringParameters: {},
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body).error).toBe('Event not found');
    });

    test('should include delivery report in response', async () => {
      docClient.send.mockResolvedValueOnce({
        Item: {
          eventId: 'evt-456',
          type: 'SHIPMENT_DEPARTED',
          tcn: 'W25K1A0456789XA',
          sourceSystem: 'GATES',
          sourceLocation: 'MOTCO',
          priority: 'HIGH',
          payload: {},
          createdAt: '2026-03-10T09:00:00Z',
          status: 'PUBLISHED',
          deliveryReport: {
            DTTS: { status: 'SUCCESS', timestamp: '2026-03-10T09:00:05Z' },
            GTN: { status: 'FAILED', error: 'Connection refused' },
          },
        },
      });

      const event = {
        pathParameters: { id: 'evt-456' },
        queryStringParameters: {},
      };

      const result = await handler(event);
      const body = JSON.parse(result.body);

      expect(body.deliveryReport.DTTS.status).toBe('SUCCESS');
      expect(body.deliveryReport.GTN.status).toBe('FAILED');
    });
  });

  describe('GET /api/events', () => {
    test('should list events without filter', async () => {
      docClient.send.mockResolvedValueOnce({
        Items: [
          {
            eventId: 'evt-1',
            type: 'MANIFEST_READY',
            tcn: 'TCN-001',
            sourceSystem: 'CMOS',
            sourceLocation: 'MOTCO',
            priority: 'HIGH',
            payload: {},
            createdAt: '2026-03-10T08:00:00Z',
            status: 'PUBLISHED',
          },
          {
            eventId: 'evt-2',
            type: 'SHIPMENT_DEPARTED',
            tcn: 'TCN-002',
            sourceSystem: 'GATES',
            sourceLocation: 'MOTCO',
            priority: 'HIGH',
            payload: {},
            createdAt: '2026-03-09T08:00:00Z',
            status: 'PUBLISHED',
          },
        ],
      });

      const event = {
        pathParameters: {},
        queryStringParameters: {},
      };

      const result = await handler(event);
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(200);
      expect(body.count).toBe(2);
      expect(body.events).toHaveLength(2);
    });

    test('should filter events by type using GSI', async () => {
      docClient.send.mockResolvedValueOnce({
        Items: [
          {
            eventId: 'evt-1',
            type: 'MANIFEST_READY',
            tcn: 'TCN-001',
            sourceSystem: 'CMOS',
            sourceLocation: 'MOTCO',
            priority: 'HIGH',
            payload: {},
            createdAt: '2026-03-10T08:00:00Z',
            status: 'PUBLISHED',
          },
        ],
      });

      const event = {
        pathParameters: {},
        queryStringParameters: { type: 'MANIFEST_READY' },
      };

      const result = await handler(event);
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(200);
      expect(body.count).toBe(1);

      // Verify QueryCommand was used (not Scan) for type filter
      const queryCall = docClient.send.mock.calls[0][0];
      expect(queryCall.IndexName).toBe('type-createdAt-index');
    });

    test('should reject invalid type filter', async () => {
      const event = {
        pathParameters: {},
        queryStringParameters: { type: 'INVALID_TYPE' },
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('Invalid notification type');
    });

    test('should respect limit parameter', async () => {
      docClient.send.mockResolvedValueOnce({ Items: [] });

      const event = {
        pathParameters: {},
        queryStringParameters: { limit: '10' },
      };

      await handler(event);

      const scanCall = docClient.send.mock.calls[0][0];
      expect(scanCall.Limit).toBe(10);
    });

    test('should default limit to 50', async () => {
      docClient.send.mockResolvedValueOnce({ Items: [] });

      const event = {
        pathParameters: {},
        queryStringParameters: {},
      };

      await handler(event);

      const scanCall = docClient.send.mock.calls[0][0];
      expect(scanCall.Limit).toBe(50);
    });

    test('should sort events by createdAt descending on scan', async () => {
      docClient.send.mockResolvedValueOnce({
        Items: [
          { eventId: 'old', type: 'MANIFEST_READY', tcn: 'T1', sourceSystem: 'S', sourceLocation: 'L', priority: 'HIGH', payload: {}, createdAt: '2026-03-01T00:00:00Z', status: 'PUBLISHED' },
          { eventId: 'new', type: 'MANIFEST_READY', tcn: 'T2', sourceSystem: 'S', sourceLocation: 'L', priority: 'HIGH', payload: {}, createdAt: '2026-03-10T00:00:00Z', status: 'PUBLISHED' },
        ],
      });

      const event = {
        pathParameters: {},
        queryStringParameters: {},
      };

      const result = await handler(event);
      const body = JSON.parse(result.body);

      // Newest event should be first
      expect(body.events[0].id).toBe('new');
      expect(body.events[1].id).toBe('old');
    });
  });

  test('should return 500 on DynamoDB error', async () => {
    docClient.send.mockRejectedValueOnce(new Error('DynamoDB error'));

    const event = {
      pathParameters: { id: 'evt-123' },
      queryStringParameters: {},
    };

    const result = await handler(event);
    expect(result.statusCode).toBe(500);
  });
});
