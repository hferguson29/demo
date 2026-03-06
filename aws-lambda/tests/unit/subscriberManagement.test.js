'use strict';

const { handler } = require('../../src/functions/subscriberManagement/index');

// Mock DynamoDB
jest.mock('../../src/shared/dynamodb', () => {
  const mockSend = jest.fn();
  return {
    docClient: { send: mockSend },
    PutCommand: jest.fn().mockImplementation((params) => params),
    GetCommand: jest.fn().mockImplementation((params) => params),
    QueryCommand: jest.fn(),
    DeleteCommand: jest.fn().mockImplementation((params) => params),
    UpdateCommand: jest.fn(),
    ScanCommand: jest.fn().mockImplementation((params) => params),
  };
});

// Mock uuid
jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('sub-test-id-456'),
}));

const { docClient } = require('../../src/shared/dynamodb');

describe('subscriberManagement Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUBSCRIBERS_TABLE = 'test-subscribers-table';
  });

  describe('POST /api/subscribe', () => {
    test('should register a new subscriber', async () => {
      docClient.send.mockResolvedValueOnce({});

      const event = {
        httpMethod: 'POST',
        pathParameters: {},
        body: JSON.stringify({
          name: 'New Analytics Platform',
          endpoint: 'http://10.0.5.42:8080/notifications',
          eventTypes: ['SHIPMENT_DEPARTED', 'DIVERSION_ALERT'],
          timeout: 5000,
        }),
      };

      const result = await handler(event);
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(201);
      expect(body.subscriberId).toBe('sub-test-id-456');
      expect(body.name).toBe('New Analytics Platform');
      expect(body.endpoint).toBe('http://10.0.5.42:8080/notifications');
      expect(body.eventTypes).toEqual(['SHIPMENT_DEPARTED', 'DIVERSION_ALERT']);
      expect(body.message).toContain('DynamoDB');
    });

    test('should reject subscriber without name', async () => {
      const event = {
        httpMethod: 'POST',
        pathParameters: {},
        body: JSON.stringify({
          endpoint: 'http://10.0.5.42:8080/notifications',
        }),
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).details).toContain('name is required');
    });

    test('should reject subscriber without endpoint', async () => {
      const event = {
        httpMethod: 'POST',
        pathParameters: {},
        body: JSON.stringify({
          name: 'Test System',
        }),
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).details).toContain('endpoint is required');
    });

    test('should reject invalid event types', async () => {
      const event = {
        httpMethod: 'POST',
        pathParameters: {},
        body: JSON.stringify({
          name: 'Test System',
          endpoint: 'http://test:8080',
          eventTypes: ['INVALID_TYPE'],
        }),
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).details[0]).toContain('Invalid event types');
    });

    test('should default eventTypes to empty array and timeout to 5000', async () => {
      docClient.send.mockResolvedValueOnce({});

      const event = {
        httpMethod: 'POST',
        pathParameters: {},
        body: JSON.stringify({
          name: 'Minimal Subscriber',
          endpoint: 'http://test:8080',
        }),
      };

      const result = await handler(event);
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(201);
      expect(body.eventTypes).toEqual([]);

      // Verify DynamoDB put
      const putCall = docClient.send.mock.calls[0][0];
      expect(putCall.Item.timeout).toBe(5000);
    });
  });

  describe('DELETE /api/subscribe/:subscriberId', () => {
    test('should delete a dynamic subscriber', async () => {
      docClient.send
        .mockResolvedValueOnce({
          Item: {
            subscriberId: 'sub-123',
            name: 'Old Analytics Platform',
            endpoint: 'http://old:8080',
          },
        })
        .mockResolvedValueOnce({});

      const event = {
        httpMethod: 'DELETE',
        pathParameters: { subscriberId: 'sub-123' },
      };

      const result = await handler(event);
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(200);
      expect(body.message).toContain('Old Analytics Platform');
    });

    test('should return 404 for non-existent subscriber', async () => {
      docClient.send.mockResolvedValueOnce({ Item: null });

      const event = {
        httpMethod: 'DELETE',
        pathParameters: { subscriberId: 'non-existent' },
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });

    test('should return 403 for built-in downstream system', async () => {
      const event = {
        httpMethod: 'DELETE',
        pathParameters: { subscriberId: 'GATES' },
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body).error).toContain('built-in');
    });

    test('should return 400 when no subscriberId provided', async () => {
      const event = {
        httpMethod: 'DELETE',
        pathParameters: {},
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });
  });

  describe('GET /api/subscribe', () => {
    test('should list built-in and dynamic subscribers', async () => {
      docClient.send.mockResolvedValueOnce({
        Items: [
          {
            subscriberId: 'sub-dyn-1',
            name: 'Analytics Platform',
            endpoint: 'http://analytics:8080',
            eventTypes: ['SHIPMENT_DEPARTED'],
            timeout: 5000,
            registeredAt: '2026-03-10T00:00:00Z',
          },
        ],
      });

      const event = {
        httpMethod: 'GET',
        pathParameters: {},
      };

      const result = await handler(event);
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(200);
      expect(body.builtInCount).toBe(8); // 8 downstream systems
      expect(body.dynamicCount).toBe(1);
      expect(body.subscribers.length).toBe(9); // 8 built-in + 1 dynamic
    });

    test('should return empty dynamic list when no subscribers registered', async () => {
      docClient.send.mockResolvedValueOnce({ Items: [] });

      const event = {
        httpMethod: 'GET',
        pathParameters: {},
      };

      const result = await handler(event);
      const body = JSON.parse(result.body);

      expect(body.builtInCount).toBe(8);
      expect(body.dynamicCount).toBe(0);
    });
  });

  test('should return 405 for unsupported HTTP method', async () => {
    const event = {
      httpMethod: 'PATCH',
      pathParameters: {},
    };

    const result = await handler(event);
    expect(result.statusCode).toBe(405);
  });
});
