'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
  ScanCommand,
} = require('@aws-sdk/lib-dynamodb');

const clientConfig = {};
if (process.env.DYNAMODB_ENDPOINT) {
  clientConfig.endpoint = process.env.DYNAMODB_ENDPOINT;
}
if (process.env.AWS_REGION) {
  clientConfig.region = process.env.AWS_REGION;
}

const client = new DynamoDBClient(clientConfig);
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

module.exports = {
  docClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
  ScanCommand,
};
