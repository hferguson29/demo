'use strict';

/**
 * Integration tests verifying the SNS → SQS → Lambda delivery chain.
 *
 * These tests validate the message flow architecture by simulating
 * the message formats at each stage of the pipeline:
 *
 * 1. API Gateway → eventIngestion Lambda → DynamoDB + SNS
 * 2. SNS → SQS (message wrapping)
 * 3. SQS → deliveryProcessor Lambda → Downstream endpoint + DynamoDB
 * 4. SQS (DLQ) → dlqProcessor Lambda → DynamoDB + CloudWatch
 */

// Mock DynamoDB
jest.mock('../../src/shared/dynamodb', () => {
  const mockSend = jest.fn().mockResolvedValue({});
  return {
    docClient: { send: mockSend },
    PutCommand: jest.fn().mockImplementation((params) => params),
    GetCommand: jest.fn().mockImplementation((params) => params),
    QueryCommand: jest.fn().mockImplementation((params) => params),
    DeleteCommand: jest.fn().mockImplementation((params) => params),
    UpdateCommand: jest.fn().mockImplementation((params) => params),
    ScanCommand: jest.fn().mockImplementation((params) => params),
  };
});

// Mock SNS
jest.mock('../../src/shared/sns', () => ({
  publishToTopic: jest.fn().mockResolvedValue({ MessageId: 'mock-sns-msg-id' }),
  snsClient: {},
  PublishCommand: jest.fn(),
}));

// Mock uuid
jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('integration-test-event-id'),
}));

const { docClient } = require('../../src/shared/dynamodb');
const { publishToTopic } = require('../../src/shared/sns');
const { handler: ingestHandler } = require('../../src/functions/eventIngestion/index');
const { handler: deliveryHandler } = require('../../src/functions/deliveryProcessor/index');
const { handler: dlqHandler } = require('../../src/functions/dlqProcessor/index');
const { handler: queryHandler } = require('../../src/functions/eventQuery/index');
const { handler: retryHandler } = require('../../src/functions/eventRetry/index');

describe('SNS → SQS → Lambda Delivery Chain Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVENTS_TABLE = 'motco-events-test';
    process.env.SUBSCRIBERS_TABLE = 'motco-subscribers-test';
    process.env.SNS_TOPIC_ARN_PREFIX = 'arn:aws:sns:us-east-1:123456789:motco-';
    process.env.TARGET_SYSTEM = 'GATES';
    process.env.TARGET_ENDPOINT = '';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.log.mockRestore();
    console.error.mockRestore();
  });

  test('Full pipeline: Ingest → SNS publish → SQS consume → DynamoDB update', async () => {
    // Step 1: Ingest event via API Gateway
    const apiEvent = {
      body: JSON.stringify({
        type: 'MANIFEST_READY',
        tcn: 'W25K1A0456789XA',
        sourceSystem: 'CMOS',
        sourceLocation: 'MOTCO_PIER2',
        payload: {
          vesselName: 'USNS Watkins',
          voyageNumber: 'V2026-0312',
          containerCount: 48,
        },
      }),
    };

    const ingestResult = await ingestHandler(apiEvent);
    const ingestBody = JSON.parse(ingestResult.body);

    expect(ingestResult.statusCode).toBe(201);
    expect(ingestBody.status).toBe('PUBLISHED');
    expect(publishToTopic).toHaveBeenCalledWith(
      'arn:aws:sns:us-east-1:123456789:motco-MANIFEST_READY',
      expect.objectContaining({
        type: 'MANIFEST_READY',
        tcn: 'W25K1A0456789XA',
      })
    );

    // Step 2: Simulate SNS → SQS message format
    // When SNS delivers to SQS, it wraps the message in an SNS envelope
    const snsPublishedMessage = publishToTopic.mock.calls[0][1];
    const sqsMessageBody = {
      Type: 'Notification',
      MessageId: 'mock-sns-msg-id',
      TopicArn: 'arn:aws:sns:us-east-1:123456789:motco-MANIFEST_READY',
      Message: JSON.stringify(snsPublishedMessage),
      Timestamp: new Date().toISOString(),
    };

    // Step 3: Delivery processor consumes from SQS
    const sqsEvent = {
      Records: [
        {
          messageId: 'sqs-msg-001',
          body: JSON.stringify(sqsMessageBody),
          attributes: {
            ApproximateReceiveCount: '1',
          },
        },
      ],
    };

    const deliveryResult = await deliveryHandler(sqsEvent);

    expect(deliveryResult.results).toHaveLength(1);
    expect(deliveryResult.results[0].status).toBe('SUCCESS');

    // Verify DynamoDB was updated with delivery status
    // First call = PutCommand (from ingest), second call = UpdateCommand (from delivery)
    const deliveryUpdateCall = docClient.send.mock.calls.find(
      (call) => call[0].ExpressionAttributeNames && call[0].ExpressionAttributeNames['#sub'] === 'GATES'
    );
    expect(deliveryUpdateCall).toBeTruthy();
  });

  test('Failed delivery → DLQ → dlqProcessor pipeline', async () => {
    // Simulate a message that has exhausted all retries and landed in DLQ
    const originalEvent = {
      id: 'evt-failed-001',
      type: 'DIVERSION_ALERT',
      tcn: 'W25K1A0456789XA',
      sourceSystem: 'USTRANSCOM_J3',
      sourceLocation: 'SCOTT_AFB',
      priority: 'CRITICAL',
      payload: {
        diversionReason: 'CONTESTED_PORT',
        originalDestination: 'APRA_HARBOR_GUAM',
        newDestination: 'WHITE_BEACH_OKINAWA',
      },
    };

    // DLQ message format (SNS → SQS → DLQ)
    const dlqEvent = {
      Records: [
        {
          messageId: 'dlq-msg-001',
          body: JSON.stringify({
            Type: 'Notification',
            Message: JSON.stringify(originalEvent),
          }),
          attributes: {
            ApproximateReceiveCount: '4',
            SentTimestamp: String(Date.now()),
          },
        },
      ],
    };

    process.env.TARGET_SYSTEM = 'GATES';
    const dlqResult = await dlqHandler(dlqEvent);

    expect(dlqResult.results).toHaveLength(1);
    expect(dlqResult.results[0].status).toBe('LOGGED_TO_DLQ');
    expect(dlqResult.results[0].eventId).toBe('evt-failed-001');

    // Verify DynamoDB update with DEAD_LETTER status
    const updateCall = docClient.send.mock.calls[0][0];
    expect(updateCall.ExpressionAttributeValues[':report'].status).toBe('DEAD_LETTER');
    expect(updateCall.ExpressionAttributeValues[':status']).toBe('PARTIALLY_FAILED');
  });

  test('Retry flow: Query event → Retry → Republish to SNS', async () => {
    // Set up mock for event query
    const storedEvent = {
      eventId: 'evt-retry-001',
      type: 'SHIPMENT_DEPARTED',
      tcn: 'W25K1A0456789XA',
      sourceSystem: 'GATES',
      sourceLocation: 'MOTCO',
      priority: 'HIGH',
      payload: { vesselName: 'USNS Watkins' },
      createdAt: '2026-03-10T09:00:00Z',
      status: 'PUBLISHED',
      deliveryReport: {
        GTN: { status: 'FAILED', error: 'Connection refused' },
        SMS: { status: 'SUCCESS', timestamp: '2026-03-10T09:00:05Z' },
      },
    };

    // Mock for query
    docClient.send.mockResolvedValueOnce({ Item: storedEvent });

    const queryEvent = {
      pathParameters: { id: 'evt-retry-001' },
      queryStringParameters: {},
    };

    const queryResult = await queryHandler(queryEvent);
    const queryBody = JSON.parse(queryResult.body);

    expect(queryResult.statusCode).toBe(200);
    expect(queryBody.deliveryReport.GTN.status).toBe('FAILED');

    // Now retry
    jest.clearAllMocks();
    docClient.send
      .mockResolvedValueOnce({ Item: storedEvent }) // GetCommand
      .mockResolvedValueOnce({}); // UpdateCommand

    const retryEvent = {
      pathParameters: { id: 'evt-retry-001' },
    };

    const retryResult = await retryHandler(retryEvent);
    const retryBody = JSON.parse(retryResult.body);

    expect(retryResult.statusCode).toBe(200);
    expect(retryBody.message).toContain('republished');

    // Verify SNS republish with retry flag
    expect(publishToTopic).toHaveBeenCalledWith(
      'arn:aws:sns:us-east-1:123456789:motco-SHIPMENT_DEPARTED',
      expect.objectContaining({
        id: 'evt-retry-001',
        isRetry: true,
      })
    );
  });

  test('Multi-subscriber fan-out: Single event → Multiple SQS queues', async () => {
    // DIVERSION_ALERT should fan out to: GATES, SMS, GTN, PLANNING_SYSTEMS, DTTS
    const ingestEvent = {
      body: JSON.stringify({
        type: 'DIVERSION_ALERT',
        tcn: 'W25K1A0456789XA',
        sourceSystem: 'USTRANSCOM_J3',
        sourceLocation: 'SCOTT_AFB',
        payload: { diversionReason: 'CONTESTED_PORT' },
      }),
    };

    await ingestHandler(ingestEvent);

    // Verify single SNS publish (fan-out happens via topic subscriptions)
    expect(publishToTopic).toHaveBeenCalledTimes(1);
    expect(publishToTopic).toHaveBeenCalledWith(
      'arn:aws:sns:us-east-1:123456789:motco-DIVERSION_ALERT',
      expect.objectContaining({ type: 'DIVERSION_ALERT' })
    );

    // Simulate each subscriber queue receiving the message
    const snsMessage = publishToTopic.mock.calls[0][1];
    const subscribers = ['GATES', 'SMS', 'GTN', 'PLANNING_SYSTEMS', 'DTTS'];

    for (const subscriber of subscribers) {
      jest.clearAllMocks();
      process.env.TARGET_SYSTEM = subscriber;

      const sqsEvent = {
        Records: [
          {
            messageId: `sqs-${subscriber}`,
            body: JSON.stringify({
              Message: JSON.stringify(snsMessage),
            }),
          },
        ],
      };

      const result = await deliveryHandler(sqsEvent);
      expect(result.results[0].status).toBe('SUCCESS');

      // Verify DynamoDB update uses correct subscriber name
      const updateCall = docClient.send.mock.calls[0][0];
      expect(updateCall.ExpressionAttributeNames['#sub']).toBe(subscriber);
    }
  });
});

describe('DynamoDB Persistence Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVENTS_TABLE = 'motco-events-test';
    process.env.SNS_TOPIC_ARN_PREFIX = 'arn:aws:sns:us-east-1:123456789:motco-';
  });

  test('Event ingestion stores complete record with TTL', async () => {
    const event = {
      body: JSON.stringify({
        type: 'SUSTAINMENT_REQUEST',
        tcn: 'P26G3B0012345XC',
        sourceSystem: 'THEATER_LOGISTICS',
        sourceLocation: 'CAMP_BLAZ_GUAM',
        payload: {
          requestingUnit: '3RD_MARINE_LITTORAL_REGIMENT',
          requestPriority: 'URGENT',
        },
      }),
    };

    await ingestHandler(event);

    const putCall = docClient.send.mock.calls[0][0];
    const item = putCall.Item;

    // Verify all required fields are stored
    expect(item.eventId).toBeDefined();
    expect(item.type).toBe('SUSTAINMENT_REQUEST');
    expect(item.tcn).toBe('P26G3B0012345XC');
    expect(item.sourceSystem).toBe('THEATER_LOGISTICS');
    expect(item.sourceLocation).toBe('CAMP_BLAZ_GUAM');
    expect(item.priority).toBe('HIGH');
    expect(item.payload.requestingUnit).toBe('3RD_MARINE_LITTORAL_REGIMENT');
    expect(item.createdAt).toBeDefined();
    expect(item.status).toBe('PUBLISHED');
    expect(item.deliveryReport).toEqual({});

    // Verify TTL is set (~90 days from now)
    const now = Math.floor(Date.now() / 1000);
    const ninetyDays = 90 * 24 * 60 * 60;
    expect(item.ttl).toBeGreaterThan(now + ninetyDays - 60);
    expect(item.ttl).toBeLessThan(now + ninetyDays + 60);
  });

  test('Event query by type uses GSI', async () => {
    docClient.send.mockResolvedValueOnce({
      Items: [
        {
          eventId: 'evt-1',
          type: 'RFID_SCAN_EVENT',
          tcn: 'TCN-RFID',
          sourceSystem: 'RFID_INTERROGATOR',
          sourceLocation: 'MOTCO_STAGING',
          priority: 'NORMAL',
          payload: {},
          createdAt: '2026-03-10T14:22:00Z',
          status: 'PUBLISHED',
        },
      ],
    });

    const event = {
      pathParameters: {},
      queryStringParameters: { type: 'RFID_SCAN_EVENT', limit: '10' },
    };

    const result = await queryHandler(event);
    const body = JSON.parse(result.body);

    expect(body.count).toBe(1);
    expect(body.events[0].type).toBe('RFID_SCAN_EVENT');

    // Verify GSI was used
    const queryCall = docClient.send.mock.calls[0][0];
    expect(queryCall.IndexName).toBe('type-createdAt-index');
    expect(queryCall.ScanIndexForward).toBe(false); // Descending order
  });
});

describe('API Parity with Legacy Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVENTS_TABLE = 'motco-events-test';
    process.env.SUBSCRIBERS_TABLE = 'motco-subscribers-test';
    process.env.SNS_TOPIC_ARN_PREFIX = 'arn:aws:sns:us-east-1:123456789:motco-';
  });

  test('POST /api/events returns same fields as legacy', async () => {
    const event = {
      body: JSON.stringify({
        type: 'MANIFEST_READY',
        tcn: 'W25K1A0456789XA',
        sourceSystem: 'CMOS',
        sourceLocation: 'MOTCO_PIER2',
        payload: { vesselName: 'USNS Watkins' },
      }),
    };

    const result = await ingestHandler(event);
    const body = JSON.parse(result.body);

    // Legacy returns: id, type, tcn, priority, createdAt, delivery
    // New returns: id, type, tcn, priority, createdAt, status, message
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('type');
    expect(body).toHaveProperty('tcn');
    expect(body).toHaveProperty('priority');
    expect(body).toHaveProperty('createdAt');
    expect(result.statusCode).toBe(201);
  });

  test('GET /api/events/:id returns same structure as legacy', async () => {
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

    const result = await queryHandler(event);
    const body = JSON.parse(result.body);

    // Legacy response fields
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('type');
    expect(body).toHaveProperty('tcn');
    expect(body).toHaveProperty('sourceSystem');
    expect(body).toHaveProperty('sourceLocation');
    expect(body).toHaveProperty('priority');
    expect(body).toHaveProperty('payload');
    expect(body).toHaveProperty('createdAt');
    expect(body).toHaveProperty('storedAt');
    expect(body).toHaveProperty('deliveryReport');
  });

  test('GET /api/events returns count and events array like legacy', async () => {
    docClient.send.mockResolvedValueOnce({ Items: [] });

    const event = {
      pathParameters: {},
      queryStringParameters: {},
    };

    const result = await queryHandler(event);
    const body = JSON.parse(result.body);

    expect(body).toHaveProperty('count');
    expect(body).toHaveProperty('events');
    expect(Array.isArray(body.events)).toBe(true);
  });

  test('POST /api/events rejects invalid type same as legacy', async () => {
    const event = {
      body: JSON.stringify({
        type: 'NOT_A_REAL_TYPE',
        tcn: 'TCN-001',
      }),
    };

    const result = await ingestHandler(event);
    expect(result.statusCode).toBe(400);

    const body = JSON.parse(result.body);
    expect(body).toHaveProperty('validTypes');
    expect(body.validTypes).toContain('MANIFEST_READY');
  });

  test('POST /api/events rejects missing TCN same as legacy', async () => {
    const event = {
      body: JSON.stringify({
        type: 'MANIFEST_READY',
      }),
    };

    const result = await ingestHandler(event);
    expect(result.statusCode).toBe(400);
  });

  test('All six notification types from legacy are supported', async () => {
    const legacyTypes = [
      'MANIFEST_READY',
      'SHIPMENT_DEPARTED',
      'SHIPMENT_DELAYED',
      'RFID_SCAN_EVENT',
      'SUSTAINMENT_REQUEST',
      'DIVERSION_ALERT',
    ];

    for (const type of legacyTypes) {
      jest.clearAllMocks();
      const event = {
        body: JSON.stringify({ type, tcn: 'TCN-PARITY-TEST' }),
      };

      const result = await ingestHandler(event);
      expect(result.statusCode).toBe(201);
    }
  });
});
