'use strict';

const { handler } = require('../../src/functions/eventRetry/index');

// Mock DynamoDB
jest.mock('../../src/shared/dynamodb', () => {
  const mockSend = jest.fn();
  return {
    docClient: { send: mockSend },
    PutCommand: jest.fn(),
    GetCommand: jest.fn().mockImplementation((params) => params),
    QueryCommand: jest.fn(),
    DeleteCommand: jest.fn(),
    UpdateCommand: jest.fn().mockImplementation((params) => params),
    ScanCommand: jest.fn(),
  };
});

// Mock SNS
jest.mock('../../src/shared/sns', () => ({
  publishToTopic: jest.fn().mockResolvedValue({ MessageId: 'mock-msg-id' }),
  snsClient: {},
  PublishCommand: jest.fn(),
}));

const { docClient } = require('../../src/shared/dynamodb');
const { publishToTopic } = require('../../src/shared/sns');

describe('eventRetry Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVENTS_TABLE = 'test-events-table';
    process.env.SNS_TOPIC_ARN_PREFIX = 'arn:aws:sns:us-east-1:123456789:motco-';
  });

  test('should republish event to SNS for retry', async () => {
    docClient.send
      .mockResolvedValueOnce({
        // GetCommand result
        Item: {
          eventId: 'evt-123',
          type: 'SHIPMENT_DEPARTED',
          tcn: 'W25K1A0456789XA',
          sourceSystem: 'GATES',
          sourceLocation: 'MOTCO',
          priority: 'HIGH',
          payload: { vesselName: 'USNS Watkins' },
          createdAt: '2026-03-10T09:00:00Z',
          deliveryReport: {
            GTN: { status: 'FAILED', error: 'Connection refused' },
          },
        },
      })
      .mockResolvedValueOnce({}); // UpdateCommand result

    const event = {
      pathParameters: { id: 'evt-123' },
    };

    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.eventId).toBe('evt-123');
    expect(body.type).toBe('SHIPMENT_DEPARTED');
    expect(body.message).toContain('republished to SNS');

    // Verify SNS publish with isRetry flag
    expect(publishToTopic).toHaveBeenCalledWith(
      'arn:aws:sns:us-east-1:123456789:motco-SHIPMENT_DEPARTED',
      expect.objectContaining({
        id: 'evt-123',
        isRetry: true,
      })
    );

    // Verify DynamoDB status update
    expect(docClient.send).toHaveBeenCalledTimes(2);
  });

  test('should return 404 for non-existent event', async () => {
    docClient.send.mockResolvedValueOnce({ Item: null });

    const event = {
      pathParameters: { id: 'non-existent' },
    };

    const result = await handler(event);
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('Event not found');
  });

  test('should return 400 when no event ID provided', async () => {
    const event = {
      pathParameters: {},
    };

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Event ID is required');
  });

  test('should update event status to RETRIED in DynamoDB', async () => {
    docClient.send
      .mockResolvedValueOnce({
        Item: {
          eventId: 'evt-789',
          type: 'DIVERSION_ALERT',
          tcn: 'TCN-001',
          sourceSystem: 'USTRANSCOM_J3',
          sourceLocation: 'SCOTT_AFB',
          priority: 'CRITICAL',
          payload: {},
          createdAt: '2026-03-10T00:00:00Z',
        },
      })
      .mockResolvedValueOnce({});

    const event = { pathParameters: { id: 'evt-789' } };
    await handler(event);

    // Second call should be UpdateCommand
    const updateCall = docClient.send.mock.calls[1][0];
    expect(updateCall.Key.eventId).toBe('evt-789');
    expect(updateCall.ExpressionAttributeValues[':status']).toBe('RETRIED');
  });

  test('should return 500 on SNS publish error', async () => {
    docClient.send.mockResolvedValueOnce({
      Item: {
        eventId: 'evt-123',
        type: 'MANIFEST_READY',
        tcn: 'TCN-001',
        sourceSystem: 'CMOS',
        sourceLocation: 'MOTCO',
        priority: 'HIGH',
        payload: {},
        createdAt: '2026-03-10T00:00:00Z',
      },
    });

    publishToTopic.mockRejectedValueOnce(new Error('SNS publish failed'));

    const event = { pathParameters: { id: 'evt-123' } };
    const result = await handler(event);
    expect(result.statusCode).toBe(500);
  });
});
