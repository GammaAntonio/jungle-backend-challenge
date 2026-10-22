import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import {
  setup,
  cleanup,
  wallet,
  bet,
  service,
  schema,
  runtimeUrl,
} from "../support";
import { db } from "../../src/infrastructure/db";
import {
  initQueues,
  send,
  queueNames,
  queueUrl,
  sqs,
} from "../../src/infrastructure/sqs";
import { WagerTransactionProcessed } from "../../src/domain/events";
import {
  aggregateMetrics,
  type MetricsSnapshot,
} from "../../src/infrastructure/metrics";
import { launch, until } from "../helpers/managed-process";

type App = ReturnType<typeof launch> & { base: string };
const workers: App[] = [];
let api: App;
let seedCount = 0;
const evidence: Record<string, unknown> = {};
const baseEnv = () => ({
  DATABASE_URL: runtimeUrl,
  DB_SCHEMA: schema,
  SQS_QUEUE_PREFIX: schema + "-",
  PORT: "0",
  METRICS_PORT: "0",
});
async function startWorker(index: number): Promise<App> {
  const app = launch("src/worker.ts", {
    ...baseEnv(),
    METRICS_INSTANCE_ID: "ar09-worker-" + index,
  });
  try {
    const port = await app.port("worker_metrics_listening");
    return { ...app, base: `http://127.0.0.1:${port}` };
  } catch (e) {
    await app.stop();
    throw e;
  }
}
async function snapshot(app: App): Promise<MetricsSnapshot> {
  const response = await fetch(app.base + "/metrics");
  if (!response.ok) throw Error("METRICS_HTTP_FAILED");
  return response.json();
}
const samples = () => Promise.all(workers.map(snapshot));
const sum = (
  rows: MetricsSnapshot[],
  key:
    | "processed"
    | "rejected"
    | "pending"
    | "duplicates"
    | "sqsRetries"
    | "outboxRetries"
    | "requests"
    | "retries",
) => rows.reduce((n, row) => n + row[key], 0);
async function deliver(
  body: ReturnType<typeof bet>,
  key: string,
  messageId = crypto.randomUUID(),
) {
  await send(
    queueNames.requests,
    {
      messageId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: { ...body, idempotencyKey: key },
    },
    body.walletId,
    crypto.randomUUID(),
  );
  return messageId;
}
beforeAll(async () => {
  await setup();
  await initQueues();
  const process = launch("src/main.ts", {
    ...baseEnv(),
    METRICS_INSTANCE_ID: "ar09-api",
  });
  const port = await process.port("http_listening");
  api = { ...process, base: `http://127.0.0.1:${port}` };
  for (let i = 0; i < 3; i++) workers.push(await startWorker(i));
  // Distinct FIFO groups let all three real receivers make progress.
  for (let batch = 0; batch < 3; batch++) {
    const jobs: (() => Promise<string>)[] = [];
    for (let i = 0; i < 30; i++) {
      const w = await wallet();
      jobs.push(() => deliver(bet(w), crypto.randomUUID()));
      seedCount++;
    }
    await Promise.all(jobs.map((run) => run()));
    await until(async () =>
      sum(await samples(), "processed") === seedCount ? true : undefined,
    );
    if ((await samples()).every((s) => s.processed > 0)) break;
  }
  evidence.initialWorkers = (await samples()).map((s, i) => ({
    pid: workers[i].child.pid,
    snapshot: s,
  }));
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  await api?.stop();
  await Bun.write(
    "docs/audit/architecture/ar09-workers.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        schema,
        seedCount,
        ...evidence,
        processLogs: workers.map((w) => ({
          pid: w.child.pid,
          events: w.events,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  await cleanup();
});

test("AR09 worker-only transactions are visible on three worker endpoints while API counters remain local", async () => {
  const rows = await samples(),
    apiRow = await snapshot(api);
  expect(rows.every((s) => s.processed > 0)).toBe(true);
  expect(sum(rows, "processed")).toBe(seedCount);
  expect(apiRow.processed).toBe(0);
  expect(apiRow.requests).toBe(0);
  expect(new Set(workers.map((w) => w.child.pid)).size).toBe(3);
  evidence.workerOnly = { workers: rows, api: apiRow };
});
test("AR09 instance labels distinguish API and workers without double counting duplicate scrapes", async () => {
  const rows = [...(await samples()), await snapshot(api)];
  expect(new Set(rows.map((s) => s.labels.instance)).size).toBe(4);
  expect(rows.slice(0, 3).every((s) => s.labels.role === "worker")).toBe(true);
  expect(rows[3].labels.role).toBe("api");
  expect(aggregateMetrics([...rows, rows[0]]).processed).toBe(seedCount);
});
let retriesBefore = 0;
let poisonTransportId = "";
test("AR09 real SQS failure increments SQS retries without claiming a successful transaction", async () => {
  const QueueUrl = await queueUrl(queueNames.requests);
  const arn = (
    await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: await queueUrl(queueNames.dlq),
        AttributeNames: ["QueueArn"],
      }),
    )
  ).Attributes!.QueueArn!;
  // Only this disposable queue uses two receives, keeping the real redrive test short.
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: arn,
          maxReceiveCount: "2",
        }),
      },
    }),
  );
  const before = await samples();
  retriesBefore = sum(before, "sqsRetries");
  const sent = await send(
    queueNames.requests,
    {
      messageId: crypto.randomUUID(),
      type: "INVALID",
      occurredAt: new Date().toISOString(),
      data: {},
    },
    "poison",
    crypto.randomUUID(),
  );
  poisonTransportId = sent.MessageId!;
  const rows = await until(async () => {
    const s = await samples();
    return sum(s, "sqsRetries") > retriesBefore ? s : undefined;
  });
  expect(sum(rows, "processed")).toBe(sum(before, "processed"));
  expect(sum(rows, "outboxRetries")).toBe(sum(before, "outboxRetries"));
  expect(sum(rows, "retries") - sum(before, "retries")).toBe(
    sum(rows, "sqsRetries") - retriesBefore,
  );
  evidence.sqsRetry = { before, after: rows };
});
test("AR09 DLQ is a shared broker gauge and aggregates once after real redrive", async () => {
  const row = await until(async () => {
    const s = await snapshot(workers[0]);
    return Number(s.dlqMessages) === 1 ? s : undefined;
  }, 25000);
  const rows = [...(await samples()), await snapshot(api)];
  expect(Number(row.dlqMessages)).toBe(1);
  const retryLogs = await until(async () => {
    const logs = workers.flatMap((w) =>
      w.events.filter(
        (e) => e.event === "sqs_retry" && e.messageId === poisonTransportId,
      ),
    );
    return logs.length === sum(rows.slice(0, 3), "sqsRetries") - retriesBefore
      ? logs
      : undefined;
  });
  expect(retryLogs.length).toBeGreaterThanOrEqual(2);
  expect(Math.min(...retryLogs.map((e) => Number(e.attempt)))).toBe(1);
  expect(sum(rows.slice(0, 3), "sqsRetries") - retriesBefore).toBe(
    retryLogs.length,
  );
  expect(rows.every((s) => s.dlqMessages === "1")).toBe(true);
  expect(aggregateMetrics(rows).dlqMessages).toBe(1);
  const QueueUrl = await queueUrl(queueNames.requests);
  const arn = (
    await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: await queueUrl(queueNames.dlq),
        AttributeNames: ["QueueArn"],
      }),
    )
  ).Attributes!.QueueArn!;
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: arn,
          maxReceiveCount: "5",
        }),
      },
    }),
  );
  evidence.dlq = {
    samples: rows,
    aggregated: aggregateMetrics(rows),
    retryLogs,
  };
});
test("AR09 message deduplication increments duplicates without a second financial effect", async () => {
  const before = await samples(),
    w = await wallet(),
    body = bet(w),
    id = crypto.randomUUID();
  await Promise.all([
    deliver(body, "ar09-duplicate", id),
    deliver(body, "ar09-duplicate", id),
    deliver(body, "ar09-duplicate", id),
  ]);
  const rows = await until(async () => {
    const s = await samples();
    return sum(s, "duplicates") === sum(before, "duplicates") + 2
      ? s
      : undefined;
  });
  expect(sum(rows, "processed") - sum(before, "processed")).toBe(1);
  expect((await service.wallet(w.id)).balance.amount).toBe("75.00");
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM ledger WHERE wallet_id=$1 AND direction='DEBIT'",
        [w.id],
      )
    )[0].n,
  ).toBe(1);
  expect((await service.reconcile(w.id)).consistent).toBe(true);
});
test("AR09 shared outbox lag is measurable without summing copies from three workers", async () => {
  const w = await wallet();
  const [opening] = await db.query(
    "SELECT id FROM wager_transaction WHERE wallet_id=$1 AND kind='OPENING'",
    [w.id],
  );
  const event = WagerTransactionProcessed.from(
    { aggregateId: w.id, correlationId: "ar09-lag" },
    { transactionId: opening.id, kind: "OPENING", balance: w.balance },
  ).toJSON();
  await db.query(
    "INSERT INTO outbox(id,aggregate_id,event_type,payload,occurred_at,next_attempt_at) VALUES($1,$2,$3,$4,now()-interval '120 seconds',now()+interval '1 hour')",
    [event.eventId, event.aggregateId, event.eventType, event],
  );
  const rows = [...(await samples()), await snapshot(api)];
  expect(rows.every((s) => Number(s.outbox?.lag_seconds) >= 120)).toBe(true);
  const aggregate = aggregateMetrics(rows);
  expect(aggregate.outbox.lag_seconds).toBe(
    Math.max(...rows.map((s) => Number(s.outbox!.lag_seconds))),
  );
  expect(aggregate.outbox.pending).toBe(
    Math.max(...rows.map((s) => s.outbox!.pending)),
  );
  evidence.outboxLag = { samples: rows, aggregated: aggregate };
});
test("AR09 processing latency is exposed for SQS, outbox and pending-reference worker activity", async () => {
  const w = await wallet();
  const before = await samples();
  const body = bet(w, "25.00", {
    kind: "REFUND",
    referenceExternalTransactionId: crypto.randomUUID(),
  });
  await deliver(body, "ar09-reference");
  const result = await until(async () => {
    const [row] = await db.query(
      "SELECT id,status FROM wager_transaction WHERE external_id=$1",
      [body.externalTransactionId],
    );
    return row?.status === "PENDING_REFERENCE" ? row : undefined;
  });
  await db.query(
    "UPDATE wager_transaction SET attempts=12,next_attempt_at=now() WHERE id=$1",
    [result.id],
  );
  const rows = await until(async () => {
    const s = await samples();
    return sum(s, "rejected") > 0 ? s : undefined;
  });
  expect(sum(rows, "pending")).toBe(sum(before, "pending") + 1);
  expect(
    rows.every(
      (s) =>
        s.processing.sqs.count > 0 &&
        s.processing.sqs.latencyMs > 0 &&
        s.latencyMs > 0,
    ),
  ).toBe(true);
  expect(
    rows.reduce((n, s) => n + s.processing.outbox.latencyMs, 0),
  ).toBeGreaterThan(0);
  expect(
    rows.reduce((n, s) => n + s.processing.reference.latencyMs, 0),
  ).toBeGreaterThan(0);
  expect((await service.reconcile(w.id)).consistent).toBe(true);
  evidence.latency = rows;
});
test("AR09 deferred commit rollback in a real worker does not increment successful metrics", async () => {
  const w = await wallet(),
    body = bet(w),
    id = crypto.randomUUID(),
    before = await samples();
  await db.query(
    `CREATE FUNCTION ar09_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.message_id='${id}' THEN RAISE EXCEPTION 'ar09 rollback'; END IF; RETURN NEW; END $$`,
  );
  await db.query(
    "CREATE CONSTRAINT TRIGGER ar09_commit_failure AFTER INSERT ON inbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ar09_commit_failure()",
  );
  let rolledBack: MetricsSnapshot[] = [];
  try {
    await deliver(body, "ar09-rollback", id);
    rolledBack = await until(async () => {
      const s = await samples();
      return sum(s, "sqsRetries") > sum(before, "sqsRetries") ? s : undefined;
    });
    expect(sum(rolledBack, "processed")).toBe(sum(before, "processed"));
    expect(sum(rolledBack, "requests")).toBe(sum(before, "requests"));
    expect((await service.wallet(w.id)).balance.amount).toBe("100.00");
    expect(
      (
        await db.query(
          "SELECT id FROM wager_transaction WHERE external_id=$1",
          [body.externalTransactionId],
        )
      ).length,
    ).toBe(0);
  } finally {
    await db.query("DROP TRIGGER ar09_commit_failure ON inbox");
    await db.query("DROP FUNCTION ar09_commit_failure()");
  }
  const committed = await until(async () => {
    const s = await samples();
    return sum(s, "processed") === sum(before, "processed") + 1 ? s : undefined;
  }, 20000);
  expect((await service.wallet(w.id)).balance.amount).toBe("75.00");
  expect((await service.reconcile(w.id)).consistent).toBe(true);
  evidence.rollback = { before, rolledBack, committed };
});
test("AR09 collector reads three real workers and API with instance-safe aggregation", async () => {
  const rows = [...(await samples()), await snapshot(api)];
  const collector = Bun.spawn(
    [
      process.execPath,
      "scripts/collect-metrics.ts",
      ...workers.map((w) => w.base + "/metrics"),
      api.base + "/metrics",
      workers[0].base + "/metrics",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = await new Response(collector.stdout).text(),
    errors = await new Response(collector.stderr).text();
  expect(await collector.exited).toBe(0);
  expect(errors).toBe("");
  const result = JSON.parse(output);
  expect(result.instances).toHaveLength(4);
  expect(result.processed).toBe(sum(rows, "processed"));
  expect(result.dlqMessages).toBe(1);
  evidence.threeWorkers = {
    pids: workers.map((w) => w.child.pid),
    samples: rows,
    collector: result,
  };
});
test("AR09 labels stay stable and exclude message wallet provider and financial data", async () => {
  for (const worker of workers) {
    const a = await snapshot(worker),
      b = await snapshot(worker);
    expect(a.labels).toEqual(b.labels);
    expect(Object.keys(a.labels).sort()).toEqual(["instance", "role"]);
    expect(a.labels.instance).toMatch(/^ar09-worker-[0-2]$/);
    for (const key of [
      "walletId",
      "transactionId",
      "messageId",
      "providerId",
      "money",
      "password",
      "DATABASE_URL",
    ])
      expect(JSON.stringify(a)).not.toContain(key);
  }
});
test("AR09 API and worker health remain correct and local metrics survive dependency probe failure", async () => {
  for (const app of [...workers, api]) {
    expect((await fetch(app.base + "/health/live")).status).toBe(200);
    expect((await fetch(app.base + "/health/ready")).status).toBe(200);
  }
  const app = launch("src/main.ts", {
    ...baseEnv(),
    METRICS_INSTANCE_ID: "ar09-unavailable",
    SQS_ENDPOINT: "http://127.0.0.1:1",
  });
  try {
    const port = await app.port("http_listening"),
      base = `http://127.0.0.1:${port}`;
    expect((await fetch(base + "/health/live")).status).toBe(200);
    expect((await fetch(base + "/health/ready")).status).toBe(503);
    const response = await fetch(base + "/metrics");
    expect(response.status).toBe(200);
    const row = await response.json();
    expect(row.dependencies.sqs).toBe(false);
    expect(row.processed).toBe(0);
  } finally {
    await app.stop();
  }
});
test("AR09 restarted worker resets process counters preserves stable instance identity and resumes work", async () => {
  const before = await snapshot(workers[0]),
    otherBefore = await Promise.all(workers.slice(1).map(snapshot));
  expect(before.processed).toBeGreaterThan(0);
  evidence.previousBootEvents = workers[0].events;
  await workers[0].stop();
  workers[0] = await startWorker(0);
  const after = await snapshot(workers[0]);
  expect(after.labels).toEqual(before.labels);
  expect(after.processStartedAt).not.toBe(before.processStartedAt);
  expect(after.processed).toBe(0);
  expect(after.duplicates).toBe(0);
  expect(after.sqsRetries).toBe(0);
  expect(after.dlqMessages).toBe("1");
  expect(Number(after.outbox?.lag_seconds)).toBeGreaterThan(120);
  const otherAfter = await Promise.all(workers.slice(1).map(snapshot));
  expect(otherAfter.map((s) => s.processed)).toEqual(
    otherBefore.map((s) => s.processed),
  );
  expect(aggregateMetrics([before, after]).processed).toBe(0);
  await Promise.all(workers.slice(1).map((w) => w.stop()));
  const w = await wallet();
  const deliveryStarted = Date.now();
  await deliver(bet(w), "ar09-after-restart");
  await Bun.sleep(2000);
  const visibility = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: await queueUrl(queueNames.requests),
      AttributeNames: [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
      ],
    }),
  );
  const resumed = await until(async () => {
    const s = await snapshot(workers[0]);
    return s.processed === 1 ? s : undefined;
  }, 45000);
  expect((await service.wallet(w.id)).balance.amount).toBe("75.00");
  expect((await service.reconcile(w.id)).consistent).toBe(true);
  evidence.restart = {
    before,
    after,
    resumed,
    visibilityDuringRecovery: visibility.Attributes,
    recoveryElapsedMs: Date.now() - deliveryStarted,
  };
});
