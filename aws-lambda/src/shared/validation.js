'use strict';

const { VALID_NOTIFICATION_TYPES } = require('./constants');

/**
 * Validate an incoming event payload.
 *
 * @param {object} body - The request body
 * @returns {{ valid: boolean, errors: string[] }} Validation result
 */
function validateEvent(body) {
  const errors = [];

  if (!body) {
    return { valid: false, errors: ['Request body is required'] };
  }

  if (!body.type) {
    errors.push('type is required');
  } else if (!VALID_NOTIFICATION_TYPES.includes(body.type)) {
    errors.push(
      `Invalid notification type: ${body.type}. Valid types: ${VALID_NOTIFICATION_TYPES.join(', ')}`
    );
  }

  if (!body.tcn) {
    errors.push('Transportation Control Number (tcn) is required');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a subscriber registration payload.
 *
 * @param {object} body - The request body
 * @returns {{ valid: boolean, errors: string[] }} Validation result
 */
function validateSubscriber(body) {
  const errors = [];

  if (!body) {
    return { valid: false, errors: ['Request body is required'] };
  }

  if (!body.name) {
    errors.push('name is required');
  }

  if (!body.endpoint) {
    errors.push('endpoint is required');
  }

  if (body.eventTypes && !Array.isArray(body.eventTypes)) {
    errors.push('eventTypes must be an array');
  }

  if (body.eventTypes && Array.isArray(body.eventTypes)) {
    const invalidTypes = body.eventTypes.filter(
      (t) => !VALID_NOTIFICATION_TYPES.includes(t)
    );
    if (invalidTypes.length > 0) {
      errors.push(
        `Invalid event types: ${invalidTypes.join(', ')}. Valid types: ${VALID_NOTIFICATION_TYPES.join(', ')}`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  validateEvent,
  validateSubscriber,
};
