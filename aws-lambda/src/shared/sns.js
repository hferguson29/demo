'use strict';

const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const clientConfig = {};
if (process.env.SNS_ENDPOINT) {
  clientConfig.endpoint = process.env.SNS_ENDPOINT;
}
if (process.env.AWS_REGION) {
  clientConfig.region = process.env.AWS_REGION;
}

const snsClient = new SNSClient(clientConfig);

/**
 * Publish an event to the appropriate SNS topic based on notification type.
 *
 * @param {string} topicArn - The SNS topic ARN
 * @param {object} event - The event object to publish
 * @returns {Promise<object>} SNS publish response
 */
async function publishToTopic(topicArn, event) {
  const command = new PublishCommand({
    TopicArn: topicArn,
    Message: JSON.stringify(event),
    MessageAttributes: {
      eventType: {
        DataType: 'String',
        StringValue: event.type,
      },
      tcn: {
        DataType: 'String',
        StringValue: event.tcn,
      },
      priority: {
        DataType: 'String',
        StringValue: event.priority || 'NORMAL',
      },
      sourceSystem: {
        DataType: 'String',
        StringValue: event.sourceSystem || 'UNKNOWN',
      },
    },
  });

  return snsClient.send(command);
}

module.exports = {
  snsClient,
  publishToTopic,
  PublishCommand,
};
