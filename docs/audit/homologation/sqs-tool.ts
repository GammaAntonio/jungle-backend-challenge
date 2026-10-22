import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

const endpoint = process.env.SQS_ENDPOINT;
const prefix = process.env.SQS_QUEUE_PREFIX;
if (!endpoint || !prefix) throw Error("ISOLATED_SQS_ENDPOINT_AND_PREFIX_REQUIRED");
const client = new SQSClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
  maxAttempts: 2,
});

async function url(name: string) {
  if (!name.startsWith(prefix)) throw Error("QUEUE_OUTSIDE_HOMOLOGATION_PREFIX");
  const result = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!result.QueueUrl) throw Error("QUEUE_URL_MISSING");
  const resolved = new URL(result.QueueUrl);
  const configured = new URL(endpoint!);
  resolved.protocol = configured.protocol;
  resolved.host = configured.host;
  return resolved.toString();
}

const [operation, file] = process.argv.slice(2);
if (operation === "list") {
  const result = await client.send(new ListQueuesCommand({ QueueNamePrefix: prefix }));
  console.log(JSON.stringify({ queueUrls: result.QueueUrls ?? [] }));
} else if (operation === "send") {
  if (!file) throw Error("MESSAGE_FIXTURE_PATH_REQUIRED");
  const fixture = await Bun.file(file).json();
  const result = await client.send(
    new SendMessageCommand({
      QueueUrl: await url(fixture.queueName),
      MessageBody: JSON.stringify(fixture.body),
      MessageGroupId: fixture.groupId,
      MessageDeduplicationId: fixture.deduplicationId,
    }),
  );
  console.log(JSON.stringify({ messageId: result.MessageId, sequenceNumber: result.SequenceNumber }));
} else if (operation === "attributes") {
  if (!file) throw Error("QUEUE_NAME_REQUIRED");
  const name = await Bun.file(file).text();
  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: await url(name.trim()),
      AttributeNames: ["All"],
    }),
  );
  console.log(JSON.stringify({ queueName: name.trim(), attributes: result.Attributes ?? {} }));
} else {
  throw Error("Use list, send, or attributes");
}
