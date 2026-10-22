import {
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

type ApiResult = { status: number; body: any; durationMs: number; url: string };
const state = await Bun.file("docs/audit/homologation/run-state.json").json();
const ports = state.hostPorts as {
  localstack: string;
  apis: string[];
  workers: string[];
};
const prefix = state.queuePrefix as string;
const endpoint = `http://${ports.localstack}`;
const apiBases = ports.apis.map((port) => `http://${port}`);
const workerBases = ports.workers.map((port) => `http://${port}`);
const queues = {
  requests: `${prefix}requests.fifo`,
  dlq: `${prefix}dlq.fifo`,
  events: `${prefix}events.fifo`,
};
const requests: unknown[] = [];
const sqs = new SQSClient({
  region: "us-east-1",
  endpoint,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 2,
});

async function api(base: string, path: string, init?: RequestInit): Promise<ApiResult> {
  const url = base + path;
  const start = performance.now();
  const response = await fetch(url, init);
  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  const result = { status: response.status, body, durationMs: performance.now() - start, url };
  requests.push({ method: init?.method ?? "GET", ...result });
  return result;
}

async function queueUrl(name: string) {
  if (!name.startsWith(prefix)) throw Error("QUEUE_OUTSIDE_HOMOLOGATION_PROJECT");
  const result = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!result.QueueUrl) throw Error("QUEUE_URL_MISSING");
  const resolved = new URL(result.QueueUrl);
  const target = new URL(endpoint);
  resolved.protocol = target.protocol;
  resolved.host = target.host;
  return resolved.toString();
}

async function attributes(name: string) {
  const result = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: await queueUrl(name),
      AttributeNames: ["All"],
    }),
  );
  return result.Attributes ?? {};
}

async function send(name: string, body: unknown, groupId: string, deduplicationId: string) {
  const result = await sqs.send(
    new SendMessageCommand({
      QueueUrl: await queueUrl(name),
      MessageBody: JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
  requests.push({ operation: "SendMessage", queue: name, messageId: result.MessageId });
  return result;
}

async function poll<T>(fn: () => Promise<T | undefined>, label: string, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value !== undefined) return { value, waitedMs: Date.now() - start };
    await Bun.sleep(500);
  }
  throw Error(`${label}_TIMEOUT_${timeoutMs}MS`);
}

const providerId = "homologation-sqs-provider";
const playerId = crypto.randomUUID();
const opened = await api(apiBases[0], "/wallets", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ playerId, initialBalance: { amount: "100.00", currency: "BRL" } }),
});
if (opened.status !== 201) throw Error(`SQS_WALLET_OPEN_FAILED_${opened.status}`);
const wallet = opened.body as { id: string; playerId: string };
const externalTransactionId = crypto.randomUUID();
const messageId = crypto.randomUUID();
const validEnvelope = {
  messageId,
  type: "WagerTransactionRequested",
  occurredAt: new Date().toISOString(),
  data: {
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    playerId,
    walletId: wallet.id,
    roundId: "sqs-round",
    gameId: "homologation-game",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  },
};
const dlqBefore = Number((await attributes(queues.dlq)).ApproximateNumberOfMessages ?? "0");
const eventsBefore = Number((await attributes(queues.events)).ApproximateNumberOfMessages ?? "0");
const redrive = JSON.parse((await attributes(queues.requests)).RedrivePolicy ?? "{}");
if (redrive.maxReceiveCount !== "5") throw Error("SQS_REDRIVE_MAX_RECEIVE_COUNT_NOT_5");
await send(queues.requests, validEnvelope, wallet.id, messageId);

const transaction = await poll(async () => {
  const result = await api(
    apiBases[1],
    `/providers/${providerId}/wagering/transactions/${externalTransactionId}`,
  );
  if (result.status !== 200) return undefined;
  return result.body;
}, "VALID_SQS_TRANSACTION");
if (transaction.value.status !== "PROCESSED") throw Error("VALID_SQS_STATUS_NOT_PROCESSED");
const balance = await api(apiBases[2], `/wallets/${wallet.id}`);
const reconciliation = await api(apiBases[0], `/wallets/${wallet.id}/reconciliation`, { method: "POST" });
if (balance.body.balance.amount !== "75.00" || reconciliation.body.consistent !== true)
  throw Error("SQS_FINANCIAL_RECONCILIATION_FAILED");

const poisonId = crypto.randomUUID();
const poisonEnvelope = {
  messageId: poisonId,
  type: "UnknownHomologationMessage",
  occurredAt: new Date().toISOString(),
  data: { walletId: crypto.randomUUID() },
};
await send(queues.requests, poisonEnvelope, `poison-${poisonId}`, poisonId);
const dlqArrival = await poll(async () => {
  const current = Number((await attributes(queues.dlq)).ApproximateNumberOfMessages ?? "0");
  return current >= dlqBefore + 1 ? current : undefined;
}, "POISON_MESSAGE_DLQ", 120_000);

const dlqMessage = await poll(async () => {
  const receive = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: await queueUrl(queues.dlq),
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
  );
  for (const message of receive.Messages ?? []) {
    if (JSON.parse(message.Body ?? "{}").messageId === poisonId) return message;
  }
  return undefined;
}, "DLQ_POISON_MESSAGE_RECEIVED", 120_000);
if (dlqMessage.value.ReceiptHandle) {
  await sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: await queueUrl(queues.dlq),
      ReceiptHandle: dlqMessage.value.ReceiptHandle,
      VisibilityTimeout: 0,
    }),
  );
}

const events = await poll(async () => {
  const count = Number((await attributes(queues.events)).ApproximateNumberOfMessages ?? "0");
  return count >= eventsBefore + 1 ? count : undefined;
}, "OUTBOX_EVENTS_PUBLISHED");
const workerMetrics = await Promise.all(
  workerBases.map(async (base) => {
    const result = await api(base, "/metrics");
    if (result.status !== 200) throw Error("WORKER_METRICS_UNAVAILABLE");
    return result.body as any;
  }),
);
const instances = new Set(workerMetrics.map((item) => item.labels.instance));
if (workerMetrics.some((item) => item.labels.role !== "worker") || instances.size !== 3)
  throw Error("THREE_WORKER_INSTANCE_LABELS_NOT_DISTINCT");
const retryCount = workerMetrics.reduce((sum, item) => sum + item.sqsRetries, 0);
if (retryCount < 5) throw Error(`SQS_RETRY_METRIC_TOO_LOW_${retryCount}`);
const sharedOutbox = workerMetrics.map((item) => item.outbox?.pending).filter((n) => n !== undefined);
if (sharedOutbox.length !== 3 || Math.max(...sharedOutbox) !== 0)
  throw Error("OUTBOX_NOT_DRAINED_AFTER_PUBLISH");
const dlqAfterAttributes = await attributes(queues.dlq);
const after = Number(dlqAfterAttributes.ApproximateNumberOfMessages ?? "0");
const afterInFlight = Number(
  dlqAfterAttributes.ApproximateNumberOfMessagesNotVisible ?? "0",
);
const requestQueueAfter = Number((await attributes(queues.requests)).ApproximateNumberOfMessages ?? "0");
if (after + afterInFlight < dlqBefore + 1 || requestQueueAfter !== 0)
  throw Error("SQS_QUEUE_FINAL_STATE_MISMATCH");

const summary = {
  generatedAt: new Date().toISOString(),
  project: state.project,
  walletId: wallet.id,
  messageId,
  externalTransactionId,
  validMessageStatus: transaction.value.status,
  balance: balance.body.balance,
  reconciliation: reconciliation.body,
  redrivePolicy: redrive,
  dlqBefore,
  dlqAfter: after,
  dlqAfterInFlight: afterInFlight,
  receivedDlqApproximateReceiveCount:
    dlqMessage.value.Attributes?.ApproximateReceiveCount ?? "not-returned",
  poisonMessageId: poisonId,
  requestQueueAfter,
  eventQueueBefore: eventsBefore,
  eventQueueVisibleMessages: events.value,
  outboxEventsWaitedMs: events.waitedMs,
  dlqWaitedMs: dlqArrival.waitedMs,
  dlqReceiveWaitedMs: dlqMessage.waitedMs,
  workerMetrics: workerMetrics.map((item) => ({
    labels: item.labels,
    processStartedAt: item.processStartedAt,
    sqsRetries: item.sqsRetries,
    processing: item.processing,
    outbox: item.outbox,
    dlqMessages: item.dlqMessages,
  })),
  aggregateSqsRetries: retryCount,
  requests,
};
await Bun.write(
  "docs/audit/homologation/logs/sqs-e2e.json",
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
