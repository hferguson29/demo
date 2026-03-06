'use strict';

const { validateEvent, validateSubscriber } = require('../../src/shared/validation');

describe('validateEvent', () => {
  test('should pass for valid event', () => {
    const result = validateEvent({
      type: 'MANIFEST_READY',
      tcn: 'W25K1A0456789XA',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('should fail for null body', () => {
    const result = validateEvent(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Request body is required');
  });

  test('should fail for missing type', () => {
    const result = validateEvent({ tcn: 'TCN-001' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('type is required');
  });

  test('should fail for invalid type', () => {
    const result = validateEvent({ type: 'INVALID', tcn: 'TCN-001' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Invalid notification type');
  });

  test('should fail for missing tcn', () => {
    const result = validateEvent({ type: 'MANIFEST_READY' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Transportation Control Number (tcn) is required');
  });

  test('should collect multiple errors', () => {
    const result = validateEvent({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  test('should validate all six notification types', () => {
    const types = [
      'MANIFEST_READY',
      'SHIPMENT_DEPARTED',
      'SHIPMENT_DELAYED',
      'RFID_SCAN_EVENT',
      'SUSTAINMENT_REQUEST',
      'DIVERSION_ALERT',
    ];

    for (const type of types) {
      const result = validateEvent({ type, tcn: 'TCN-001' });
      expect(result.valid).toBe(true);
    }
  });
});

describe('validateSubscriber', () => {
  test('should pass for valid subscriber', () => {
    const result = validateSubscriber({
      name: 'Test System',
      endpoint: 'http://test:8080',
      eventTypes: ['MANIFEST_READY'],
    });
    expect(result.valid).toBe(true);
  });

  test('should fail for null body', () => {
    const result = validateSubscriber(null);
    expect(result.valid).toBe(false);
  });

  test('should fail for missing name', () => {
    const result = validateSubscriber({ endpoint: 'http://test:8080' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('name is required');
  });

  test('should fail for missing endpoint', () => {
    const result = validateSubscriber({ name: 'Test' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('endpoint is required');
  });

  test('should fail for non-array eventTypes', () => {
    const result = validateSubscriber({
      name: 'Test',
      endpoint: 'http://test:8080',
      eventTypes: 'MANIFEST_READY',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('eventTypes must be an array');
  });

  test('should fail for invalid event types in array', () => {
    const result = validateSubscriber({
      name: 'Test',
      endpoint: 'http://test:8080',
      eventTypes: ['MANIFEST_READY', 'INVALID_TYPE'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Invalid event types');
  });

  test('should pass without eventTypes', () => {
    const result = validateSubscriber({
      name: 'Test',
      endpoint: 'http://test:8080',
    });
    expect(result.valid).toBe(true);
  });
});
