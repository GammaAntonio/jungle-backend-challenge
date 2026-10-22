import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { db } from "./db";
import { sqs, queueNames, queueUrl } from "./sqs";
import { metrics, metricIdentity, log } from "../application/observability";

export async function readiness() {
  await db.query("SELECT 1");
  await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: await queueUrl(queueNames.requests),
      AttributeNames: ["QueueArn"],
    }),
  );
}
export async function collectMetrics() {
  const [outbox, dlq] = await Promise.allSettled([
    db.query(
      "SELECT count(*)::integer AS pending,COALESCE(extract(epoch FROM now()-min(occurred_at)),0)::text AS lag_seconds FROM outbox WHERE published_at IS NULL",
    ) as Promise<{ pending: number; lag_seconds: string }[]>,
    queueUrl(queueNames.dlq).then((QueueUrl) =>
      sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
      ),
    ),
  ]);
  return {
    labels: metricIdentity.labels(),
    processStartedAt: metricIdentity.startedAt,
    sampledAt: new Date().toISOString(),
    scope: {
      counters: "process",
      outbox: "shared",
      dlqMessages: "shared",
    } as const,
    ...structuredClone(metrics),
    outbox: outbox.status === "fulfilled" ? outbox.value[0] : null,
    dlqMessages:
      dlq.status === "fulfilled"
        ? (dlq.value.Attributes?.ApproximateNumberOfMessages ?? "0")
        : null,
    dependencies: {
      postgres: outbox.status === "fulfilled",
      sqs: dlq.status === "fulfilled",
    },
  };
}
export type MetricsSnapshot = Awaited<ReturnType<typeof collectMetrics>>;
const counters = [
  "duplicates",
  "retries",
  "sqsRetries",
  "outboxRetries",
  "transactionRetries",
  "lockConflicts",
  "uniqueConflicts",
  "divergences",
  "processed",
  "rejected",
  "pending",
  "latencyMs",
  "requests",
] as const;
export function aggregateMetrics(samples: MetricsSnapshot[]) {
  const instances = new Map<string, MetricsSnapshot>();
  for (const sample of samples) {
    const key = sample.labels.role + ":" + sample.labels.instance;
    const old = instances.get(key);
    if (
      !old ||
      sample.processStartedAt > old.processStartedAt ||
      (sample.processStartedAt === old.processStartedAt &&
        sample.sampledAt > old.sampledAt)
    )
      instances.set(key, sample);
  }
  const distinct = [...instances.values()];
  const local = Object.fromEntries(
    counters.map((key) => [
      key,
      distinct.reduce((total, sample) => total + sample[key], 0),
    ]),
  ) as { [K in (typeof counters)[number]]: number };
  const processing = Object.fromEntries(
    (["sqs", "outbox", "reference"] as const).map((source) => [
      source,
      {
        count: distinct.reduce((sum, s) => sum + s.processing[source].count, 0),
        latencyMs: distinct.reduce(
          (sum, s) => sum + s.processing[source].latencyMs,
          0,
        ),
      },
    ]),
  );
  const max = (values: number[]) =>
    values.length ? Math.max(...values) : null;
  return {
    instances: distinct.map((s) => ({
      labels: s.labels,
      processStartedAt: s.processStartedAt,
    })),
    ...local,
    processing,
    outbox: {
      pending: max(
        distinct.flatMap((s) => (s.outbox ? [s.outbox.pending] : [])),
      ),
      lag_seconds: max(
        distinct.flatMap((s) =>
          s.outbox ? [Number(s.outbox.lag_seconds)] : [],
        ),
      ),
    },
    dlqMessages: max(
      distinct.flatMap((s) =>
        s.dlqMessages === null ? [] : [Number(s.dlqMessages)],
      ),
    ),
  };
}
export function startWorkerMetrics(stopping: () => boolean) {
  const server = Bun.serve({
    hostname: process.env.METRICS_HOST ?? "127.0.0.1",
    port: Number(process.env.METRICS_PORT ?? 3001),
    async fetch(request) {
      const route = new URL(request.url).pathname;
      if (request.method !== "GET") return new Response(null, { status: 405 });
      if (route === "/metrics")
        return Response.json(await collectMetrics(), {
          headers: { "cache-control": "no-store" },
        });
      if (route === "/health/live") return Response.json({ status: "ok" });
      if (route === "/health/ready") {
        try {
          if (stopping()) throw Error("STOPPING");
          await readiness();
          return Response.json({ status: "ready" });
        } catch {
          return Response.json({ status: "unavailable" }, { status: 503 });
        }
      }
      return new Response(null, { status: 404 });
    },
  });
  log("worker_metrics_listening", {
    port: server.port,
    ...metricIdentity.labels(),
  });
  return server;
}
