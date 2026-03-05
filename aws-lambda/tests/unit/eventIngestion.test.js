'use strict';

const { handler } = require('../../src/functions/eventIngestion/index');

// Mock DynamoDB
jest.mock('../../src/shared/dynamodb', () => {
  const mockSend = jest.fn().mockResolvedValue({});
  return {
    docClient: { send: mockSend },
    PutCommand: jest.fn().mockImplementation((params) => params),
    GetCommand: jest.fn(),
    QueryCommand: jest.fn(),
    DeleteCommand: jest.fn(),
    UpdateCommand: jest.fn(),
    ScanCommand: jest.fn(),
  };
});

// Mock SNS
jest.mock('../../src/shared/sns', () => ({
  publishToTopic: jest.fn().mockResolvedValue({ MessageId: 'mock-msg-id' }),
  snsClient: {},
  PublishCommand: jest.fn(),
}));

// Mock uuid
jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-event-id-123'),
}));

const { docClient } = require('../../src/shared/dynamodb');
const { publishToTopic } = require('../../src/shared/sns');

describe('eventIngestion Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVENTS_TABLE = 'test-events-table';
    process.env.SNS_TOPIC_ARN_PREFIX = 'arn:aws:sns:us-east-1:123456789:motco-';
  });

  test('should ingest a valid MANIFEST_READY event', async () => {
    const event = {
      body: JSON.stringify({
        type: 'MANIFEST_READY',
        tcn: 'W25K1A0456789XA',
        sourceSystem: 'CMOS',
        sourceLocation: 'MOTCO_PIER2',
        payload: {
          vesselName: 'USNS Watkins',
          voyageNumber: 'V2026-0312',
          cargoType: 'AMMUNITION',
          containerCount: 48,
        },
      }),
    };

    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(201);
    expect(body.id).toBe('test-event-id-123');
    expect(body.type).toBe('MANIFEST_READY');
    expect(body.tcn).toBe('W25K1A0456789XA');
    expect(body.priority).toBe('HIGH');
    expect(body.status).toBe('PUBLISHED');

    // Verify DynamoDB put was called
    expect(docClient.send).toHaveBeenCalledTimes(1);

    // Verify SNS publish was called with correct topic ARN
    expect(publishToTopic).toHaveBeenCalledWith(
      'arn:aws:sns:us-east-1:123456789:motco-MANIFEST_READY',
      expect.objectContaining({
        id: 'test-event-id-123',
        type: 'MANIFEST_READY',
        tcn: 'W25K1A0456789XA',
      })
    );
  });

  test('should ingest a valid DIVERSION_ALERT event', async () => {
    const event = {
      body: JSON.stringify({
        type: 'DIVERSION_ALERT',
        tcn: 'W25K1A0456789XA',
        sourceSystem: 'USTRANSCOM_J3',
        sourceLocation: 'SCOTT_AFB',
        payload: {
          diversionReason: 'CONTESTED_PORT',
        },
      }),
    };

    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(201);
    expect(body.type).toBe('DIVERSION_ALERT');
    expect(body.priority).toBe('CRITICAL');
  });

  test('should reject event with invalid type', async () => {
    const event = {
      body: JSON.stringify({
        type: 'INVALID_TYPE',
        tcn: 'W25K1A0456789XA',
      }),
    };

    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(400);
    expect(body.error).toBe('Validation failed');
    expect(body.details[0]).toContain('Invalid notification type');
  });

  test('should reject event without type', async () => {
    const event = {
      body: JSON.stringify({
        tcn: 'W25K1A0456789XA',
      }),
    };

    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(400);
    expect(body.details).toContain('type is required');
  });

  test('should reject event without TCN', async () => {
    const event = {
      body: JSON.stringify({
        type: 'MANIFEST_READY',
      }),
    };

    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(400);
    expect(body.details).toContain(
      'Transportation Control Number (tcn) is required'
    );
  });

  test('should default sourceSystem and sourceLocation to UNKNOWN', async () => {
    const event = {
      body: JSON.stringify({
        type: 'RFID_SCAN_EVENT',
        tcn: 'W25K1A0456789XA',
      }),
    };

    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(201);

    // Verify the DynamoDB put had UNKNOWN defaults
    const putCall = docClient.send.mock.calls[0][0];
    expect(putCall.Item.sourceSystem).toBe('UNKNOWN');
    expect(putCall.Item.sourceLocation).toBe('UNKNOWN');
  });

  test('should handle body as parsed object (not string)', async () => {
    const event = {
      body: {
        type: 'SHIPMENT_DEPARTED',
        tcn: 'W25K1A0456789XA',
        sourceSystem: 'GATES',
      },
    };

    const result = await handler(event);
    expect(result.statusCode).toBe(201);
  });

  test('should return 500 on DynamoDB error', async () => {
    docClient.send.mockRejectedValueOnce(new Error('DynamoDB connection failed'));

    const event = {
      body: JSON.stringify({
        type: 'MANIFEST_READY',
        tcn: 'W25K1A0456789XA',
      }),
    };

    const result = await handler(event);
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toBe('Internal server error');
  });

  test('should set TTL attribute for 90-day expiry', async () => {
    const event = {
      body: JSON.stringify({
        type: 'SHIPMENT_DELAYED',
        tcn: 'W25K1A0456789XA',
      }),
    };

    await handler(event);

    const putCall = docClient.send.mock.calls[0][0];
    const ttl = putCall.Item.ttl;
    const now = Math.floor(Date.now() / 1000);
    const ninetyDays = 90 * 24 * 60 * 60;

    // TTL should be roughly now + 90 days (within 10 seconds)
    expect(ttl).toBeGreaterThan(now + ninetyDays - 10);
    expect(ttl).toBeLessThan(now + ninetyDays + 10);
  });

  test('should handle all six notification types', async () => {
    const types = [
      'MANIFEST_READY',
      'SHIPMENT_DEPARTED',
      'SHIPMENT_DELAYED',
      'RFID_SCAN_EVENT',
      'SUSTAINMENT_REQUEST',
      'DIVERSION_ALERT',
    ];

    for (const type of types) {
      jest.clearAllMocks();
      const event = {
        body: JSON.stringify({ type, tcn: 'TEST-TCN-001' }),
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(201);
      expect(JSON.parse(result.body).type).toBe(type);
    }
  });
});
