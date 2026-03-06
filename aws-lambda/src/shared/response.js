'use strict';

/**
 * Build a standard API Gateway proxy response.
 *
 * @param {number} statusCode - HTTP status code
 * @param {object} body - Response body (will be JSON-stringified)
 * @returns {object} API Gateway proxy response
 */
function buildResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

module.exports = { buildResponse };
