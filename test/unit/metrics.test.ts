import { expect, test } from "bun:test";
import { metrics, recordRetry } from "../../src/application/observability";
import {
  aggregateMetrics,
  type MetricsSnapshot,
} from "../../src/infrastructure/metrics";

test("AR09 retry sources and lock conflicts are distinct operational counters", () => {
  const before = structuredClone(metrics);
  try {
    recordRetry("sqs");
    recordRetry("outbox");
    recordRetry("transaction", "23505");
    recordRetry("transaction", "40P01");
    recordRetry("transaction", "40001");
    expect(metrics.retries - before.retries).toBe(5);
    expect(metrics.sqsRetries - before.sqsRetries).toBe(1);
    expect(metrics.outboxRetries - before.outboxRetries).toBe(1);
    expect(metrics.transactionRetries - before.transactionRetries).toBe(3);
    expect(metrics.uniqueConflicts - before.uniqueConflicts).toBe(1);
    expect(metrics.lockConflicts - before.lockConflicts).toBe(2);
  } finally {
    Object.assign(metrics, before);
  }
});
function sample(
  id: string,
  processed: number,
  started = "2026-01-01T00:00:00.000Z",
): MetricsSnapshot {
  return {
    ...structuredClone(metrics),
    processed,
    labels: { instance: id, role: "worker" },
    processStartedAt: started,
    sampledAt: "2026-01-02T00:00:00.000Z",
    scope: { counters: "process", outbox: "shared", dlqMessages: "shared" },
    outbox: { pending: 3, lag_seconds: "12" },
    dlqMessages: "2",
    dependencies: { postgres: true, sqs: true },
  };
}
test("AR09 aggregation sums distinct processes and never sums replicated shared gauges", () => {
  const a = sample("worker-1", 7),
    b = sample("worker-2", 5);
  const result = aggregateMetrics([a, b, a]);
  expect(result.instances).toHaveLength(2);
  expect(result.processed).toBe(12);
  expect(result.outbox).toEqual({ pending: 3, lag_seconds: 12 });
  expect(result.dlqMessages).toBe(2);
});
test("AR09 aggregation replaces old boot counters instead of adding them after restart", () => {
  const result = aggregateMetrics([
    sample("worker-1", 10),
    sample("worker-1", 0, "2026-01-01T01:00:00.000Z"),
  ]);
  expect(result.instances).toHaveLength(1);
  expect(result.processed).toBe(0);
});
