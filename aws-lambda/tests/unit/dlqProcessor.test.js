'use strict';

const { handler } = require('../../src/functions/dlqProcessor/index');

// Mock DynamoDB
jest.mock('../../src/shared/dynamodb', () => {
  const mockSend = jest.fn().mockResolvedValue({});
  return {
    docClient: { send: mockSend },
    PutCommand: jest.fn(),
    GetCommand: jest.fn(),
    QueryCommand: jest.fn(),
    DeleteCommand: jest.fn(),
    UpdateCommand: jest.fn().mockImplementation((params) => params),
    ScanCommand: jest.fn(),
  };
});

const { docClient } = require('../../src/shared/dynamodb');

describe('dlqProcessor Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVENTS_TABLE = 'test-events-table';
    process.env.TARGET_SYSTEM = 'GATES';
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
    console.log.mockRestore();
  });

  test('should process DLQ message and update DynamoDB with DEAD_LETTER status', async () => {
    const dlqEvent = {
      Records: [
        {
          messageId: 'dlq-msg-123',
          body: JSON.stringify({
            Message: JSON.stringify({
              id: 'evt-fail-123',
              type: 'MANIFEST_READY',
              tcn: 'W25K1A0456789XA',
              sourceSystem: 'CMOS',
            }),
          }),
          attributes: {
            ApproximateReceiveCount: '4',
            SentTimestamp: '1709856000000',
          },
        },
      ],
    };

    const result = await handler(dlqEvent);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe('LOGGED_TO_DLQ');
    expect(result.results[0].eventId).toBe('evt-fail-123');
    expect(result.results[0].targetSystem).toBe('GATES');

    // Verify DynamoDB update with DEAD_LETTER status
    expect(docClient.send).toHaveBeenCalledTimes(1);
    const updateCall = docClient.send.mock.calls[0][0];
    expect(updateCall.Key.eventId).toBe('evt-fail-123');
    expect(updateCall.ExpressionAttributeValues[':report'].status).toBe('DEAD_LETTER');
    expect(updateCall.ExpressionAttributeValues[':status']).toBe('PARTIALLY_FAILED');
  });

  test('should log permanent failure with full context', async () => {
    const dlqEvent = {
      Records: [
        {
          messageId: 'dlq-msg-456',
          body: JSON.stringify({
            Message: JSON.stringify({
              id: 'evt-fail-456',
              type: 'DIVERSION_ALERT',
              tcn: 'TCN-CRITICAL',
              sourceSystem: 'USTRANSCOM_J3',
            }),
          }),
          attributes: {
            ApproximateReceiveCount: '3',
            SentTimestamp: '1709856000000',
          },
        },
      ],
    };

    await handler(dlqEvent);

    // Verify error logging
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('PERMANENT DELIVERY FAILURE')
    );
  });

  test('should handle unparseable DLQ messages gracefully', async () => {
    const dlqEvent = {
      Records: [
        {
          messageId: 'dlq-msg-bad',
          body: 'not-valid-json{{{{',
          attributes: {},
        },
      ],
    };

    const result = await handler(dlqEvent);

    // Should not throw — DLQ processor should always succeed
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe('LOGGED_TO_DLQ');
  });

  test('should process multiple DLQ records', async () => {
    const dlqEvent = {
      Records: [
        {
          messageId: 'dlq-1',
          body: JSON.stringify({
            Message: JSON.stringify({
              id: 'evt-1',
              type: 'MANIFEST_READY',
              tcn: 'TCN-1',
              sourceSystem: 'CMOS',
            }),
          }),
          attributes: { ApproximateReceiveCount: '4' },
        },
        {
          messageId: 'dlq-2',
          body: JSON.stringify({
            Message: JSON.stringify({
              id: 'evt-2',
              type: 'SHIPMENT_DELAYED',
              tcn: 'TCN-2',
              sourceSystem: 'DTTS',
            }),
          }),
          attributes: { ApproximateReceiveCount: '4' },
        },
      ],
    };

    const result = await handler(dlqEvent);

    expect(result.results).toHaveLength(2);
    expect(docClient.send).toHaveBeenCalledTimes(2);
  });

  test('should not throw even if DynamoDB update fails', async () => {
    docClient.send.mockRejectedValueOnce(new Error('DynamoDB error'));

    const dlqEvent = {
      Records: [
        {
          messageId: 'dlq-msg-err',
          body: JSON.stringify({
            Message: JSON.stringify({
              id: 'evt-err',
              type: 'MANIFEST_READY',
              tcn: 'TCN-ERR',
              sourceSystem: 'CMOS',
            }),
          }),
          attributes: {},
        },
      ],
    };

    // DLQ processor should NEVER throw — we don't want messages going back
    const result = await handler(dlqEvent);
    expect(result.results).toHaveLength(1);
  });

  test('should use TARGET_SYSTEM from environment variable', async () => {
    process.env.TARGET_SYSTEM = 'SMS';

    const dlqEvent = {
      Records: [
        {
          messageId: 'dlq-sms',
          body: JSON.stringify({
            Message: JSON.stringify({
              id: 'evt-sms-fail',
              type: 'SHIPMENT_DEPARTED',
              tcn: 'TCN-SMS',
              sourceSystem: 'GATES',
            }),
          }),
          attributes: { ApproximateReceiveCount: '3' },
        },
      ],
    };

    const result = await handler(dlqEvent);
    expect(result.results[0].targetSystem).toBe('SMS');
  });
});
