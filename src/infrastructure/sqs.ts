import type { StoredIntegrationEvent } from "../domain/events";
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
export const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
  maxAttempts: 2,
});
export const queueNames = {
  requests: "wager-transactions.fifo",
  dlq: "wager-transactions-dlq.fifo",
  events: "wager-events.fifo",
};
export function configureQueuePrefix(prefix: string) {
  queueNames.requests = prefix + "requests.fifo";
  queueNames.dlq = prefix + "dlq.fifo";
  queueNames.events = prefix + "events.fifo";
}
if (process.env.SQS_QUEUE_PREFIX)
  configureQueuePrefix(process.env.SQS_QUEUE_PREFIX);
export async function queueUrl(name: string) {
  const r = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!r.QueueUrl) throw Error("QUEUE_URL_MISSING");
  const endpoint = new URL(process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566");
  const url = new URL(r.QueueUrl);
  url.host = endpoint.host;
  url.protocol = endpoint.protocol;
  return url.toString();
}
export async function initQueues() {
  for (const name of Object.values(queueNames))
    await sqs.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
          VisibilityTimeout: "30",
        },
      }),
    );
  const dlq = await queueUrl(queueNames.dlq);
  const attrs = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlq,
      AttributeNames: ["QueueArn"],
    }),
  );
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: await queueUrl(queueNames.requests),
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: attrs.Attributes!.QueueArn,
          maxReceiveCount: "5",
        }),
      },
    }),
  );
}
export async function sendIntegrationEvent(event: StoredIntegrationEvent) {
  return send(queueNames.events, event, event.aggregateId, event.eventId);
}
export async function send(
  name: string,
  body: unknown,
  groupId: string,
  dedupId: string,
) {
  return sqs.send(
    new SendMessageCommand({
      QueueUrl: await queueUrl(name),
      MessageBody: JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: dedupId,
    }),
  );
}
