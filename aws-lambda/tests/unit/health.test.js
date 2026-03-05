'use strict';

const { handler } = require('../../src/functions/health/index');

describe('health Lambda', () => {
  test('should return 200 with service status', async () => {
    const result = await handler();
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.status).toBe('OK');
    expect(body.service).toBe('MOTCO Notification Service');
    expect(body.version).toBe('2.0.0');
    expect(body.architecture).toContain('AWS_SERVERLESS');
  });

  test('should list serverless capabilities', async () => {
    const result = await handler();
    const body = JSON.parse(result.body);

    expect(body.capabilities).toBeInstanceOf(Array);
    expect(body.capabilities.length).toBeGreaterThan(0);

    // Check key capabilities are listed
    const capabilitiesText = body.capabilities.join(' ');
    expect(capabilitiesText).toContain('DynamoDB');
    expect(capabilitiesText).toContain('SNS');
    expect(capabilitiesText).toContain('SQS');
    expect(capabilitiesText).toContain('DLQ');
  });

  test('should list improvements over legacy architecture', async () => {
    const result = await handler();
    const body = JSON.parse(result.body);

    expect(body.improvements).toBeInstanceOf(Array);
    expect(body.improvements.length).toBeGreaterThan(0);

    const improvementsText = body.improvements.join(' ');
    expect(improvementsText).toContain('persistence');
    expect(improvementsText).toContain('retry');
    expect(improvementsText).toContain('dead letter');
  });

  test('should return proper CORS headers', async () => {
    const result = await handler();

    expect(result.headers['Content-Type']).toBe('application/json');
    expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});
