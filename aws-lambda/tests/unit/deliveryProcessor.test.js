'use strict';

const { handler } = require('../../src/functions/deliveryProcessor/index');

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

// Mock http/https
jest.mock('http', () => ({
  request: jest.fn(),
}));

const { docClient } = require('../../src/shared/dynamodb');
const http = require('http');

describe('deliveryProcessor Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVENTS_TABLE = 'test-events-table';
    process.env.TARGET_SYSTEM = 'GATES';
    process.env.TARGET_ENDPOINT = '';
    process.env.DELIVERY_TIMEOUT = '5000';
  });

  test('should process SQS message and update delivery status', async () => {
    const sqsEvent = {
      Records: [
        {
          messageId: 'msg-123',
          body: JSON.stringify({
            Message: JSON.stringify({
              id: 'evt-123',
              type: 'MANIFEST_READY',
              tcn: 'W25K1A0456789XA',
              sourceSystem: 'CMOS',
              payload: {},
            }),
          }),
        },
      ],
    };

    const result = await handler(sqsEvent);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe('SUCCESS');

    // Verify DynamoDB update was called
    expect(docClient.send).toHaveBeenCalledTimes(1);
    const updateCall = docClient.send.mock.calls[0][0];
    expect(updateCall.Key.eventId).toBe('evt-123');
  });

  test('should process message without SNS wrapper', async () => {
    const sqsEvent = {
      Records: [
        {
          messageId: 'msg-456',
          body: JSON.stringify({
            body: JSON.stringify({
              id: 'evt-456',
              type: 'SHIPMENT_DEPARTED',
              tcn: 'TCN-002',
              sourceSystem: 'GATES',
              payload: {},
            }),
          }),
        },
      ],
    };

    const result = await handler(sqsEvent);
    expect(result.results[0].status).toBe('SUCCESS');
  });

  test('should deliver to endpoint when TARGET_ENDPOINT is set', async () => {
    process.env.TARGET_ENDPOINT = 'http://localhost:4001/ingest';

    const mockReq = {
      on: jest.fn().mockReturnThis(),
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
    };

    http.request.mockImplementation((options, callback) => {
      const mockRes = {
        statusCode: 200,
        on: jest.fn().mockImplementation((event, cb) => {
          if (event === 'data') cb('OK');
          if (event === 'end') cb();
          return mockRes;
        }),
      };
      callback(mockRes);
      return mockReq;
    });

    const sqsEvent = {
      Records: [
        {
          messageId: 'msg-789',
          body: JSON.stringify({
            Message: JSON.stringify({
              id: 'evt-789',
              type: 'DIVERSION_ALERT',
              tcn: 'TCN-003',
              sourceSystem: 'USTRANSCOM_J3',
              payload: {},
            }),
          }),
        },
      ],
    };

    const result = await handler(sqsEvent);
    expect(result.results[0].status).toBe('SUCCESS');
    expect(http.request).toHaveBeenCalled();
  });

  test('should throw on delivery failure to let SQS retry', async () => {
    process.env.TARGET_ENDPOINT = 'http://localhost:4001/ingest';

    const mockReq = {
      on: jest.fn().mockImplementation((event, cb) => {
        if (event === 'error') {
          setTimeout(() => cb(new Error('Connection refused')), 0);
        }
        return mockReq;
      }),
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
    };

    http.request.mockReturnValue(mockReq);

    const sqsEvent = {
      Records: [
        {
          messageId: 'msg-fail',
          body: JSON.stringify({
            Message: JSON.stringify({
              id: 'evt-fail',
              type: 'MANIFEST_READY',
              tcn: 'TCN-FAIL',
              sourceSystem: 'CMOS',
              payload: {},
            }),
          }),
        },
      ],
    };

    // Should throw so SQS retries
    await expect(handler(sqsEvent)).rejects.toThrow();
  });

  test('should handle multiple records in batch', async () => {
    const sqsEvent = {
      Records: [
        {
          messageId: 'msg-1',
          body: JSON.stringify({
            Message: JSON.stringify({
              id: 'evt-1',
              type: 'MANIFEST_READY',
              tcn: 'TCN-001',
              sourceSystem: 'CMOS',
              payload: {},
            }),
          }),
        },
        {
          messageId: 'msg-2',
          body: JSON.stringify({
            Message: JSON.stringify({
              id: 'evt-2',
              type: 'SHIPMENT_DEPARTED',
              tcn: 'TCN-002',
              sourceSystem: 'GATES',
              payload: {},
            }),
          }),
        },
      ],
    };

    const result = await handler(sqsEvent);
    expect(result.results).toHaveLength(2);
    expect(docClient.send).toHaveBeenCalledTimes(2);
  });

  test('should use TARGET_SYSTEM from environment variable', async () => {
    process.env.TARGET_SYSTEM = 'GTN';

    const sqsEvent = {
      Records: [
        {
          messageId: 'msg-100',
          body: JSON.stringify({
            Message: JSON.stringify({
              id: 'evt-100',
              type: 'RFID_SCAN_EVENT',
              tcn: 'TCN-100',
              sourceSystem: 'RFID_INTERROGATOR',
              payload: {},
            }),
          }),
        },
      ],
    };

    await handler(sqsEvent);

    const updateCall = docClient.send.mock.calls[0][0];
    expect(updateCall.ExpressionAttributeNames['#sub']).toBe('GTN');
  });
});
