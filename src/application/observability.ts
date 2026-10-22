import { resolveCorrelationId } from "./correlation";
import { hostname } from "node:os";
const instance =
  process.env.METRICS_INSTANCE_ID ??
  hostname().slice(0, 48) + "-" + process.pid;
if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(instance))
  throw Error("INVALID_METRICS_INSTANCE_ID");
let role: "api" | "worker" | "application" = "application";
export function setMetricRole(value: "api" | "worker") {
  role = value;
}
export const metricIdentity = {
  startedAt: new Date().toISOString(),
  labels: () => ({ instance, role }),
};
export const metrics = {
  duplicates: 0,
  retries: 0,
  sqsRetries: 0,
  outboxRetries: 0,
  transactionRetries: 0,
  uniqueConflicts: 0,
  processing: {
    sqs: { count: 0, latencyMs: 0 },
    outbox: { count: 0, latencyMs: 0 },
    reference: { count: 0, latencyMs: 0 },
  },
  lockConflicts: 0,
  divergences: 0,
  processed: 0,
  rejected: 0,
  pending: 0,
  latencyMs: 0,
  requests: 0,
};
export function recordRetry(
  source: "sqs" | "outbox" | "transaction",
  code?: string,
) {
  metrics.retries++;
  if (source === "sqs") metrics.sqsRetries++;
  else if (source === "outbox") metrics.outboxRetries++;
  else {
    metrics.transactionRetries++;
    if (code === "23505") metrics.uniqueConflicts++;
    else if (code === "40P01" || code === "40001") metrics.lockConflicts++;
  }
}
export function recordProcessing(
  source: keyof typeof metrics.processing,
  elapsedMs: number,
) {
  metrics.processing[source].count++;
  metrics.processing[source].latencyMs += Math.max(0, elapsedMs);
}
export async function measureProcessing<T>(
  source: keyof typeof metrics.processing,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    recordProcessing(source, performance.now() - started);
  }
}
export function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...fields,
      correlationId: resolveCorrelationId(fields.correlationId),
    }),
  );
}
export interface ProviderIdentityPort {
  authorize(providerId: string): Promise<boolean>;
}
export class DevelopmentProviderIdentity implements ProviderIdentityPort {
  async authorize(_providerId: string) {
    return true;
  }
}
