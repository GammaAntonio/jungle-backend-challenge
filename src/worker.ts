import { connectRuntime, db } from "./infrastructure/db";
import { assertRuntimeDatabaseConfiguration } from "./infrastructure/permissions";
import { initQueues } from "./infrastructure/sqs";
import { publishBatch } from "./infrastructure/outbox";
import { consumeOnce } from "./infrastructure/consumer";
import { WageringService } from "./application/wagering";
import { log, setMetricRole } from "./application/observability";
import { startWorkerMetrics } from "./infrastructure/metrics";
setMetricRole("worker");
assertRuntimeDatabaseConfiguration();
await connectRuntime();
await initQueues();
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
const metricsServer = startWorkerMetrics(() => stopping);
const service = new WageringService();
await Promise.all([
  (async () => {
    while (!stopping) {
      try {
        await consumeOnce(service, () => stopping);
      } catch {
        log("consumer_unavailable");
        await Bun.sleep(1000);
      }
    }
  })(),
  (async () => {
    while (!stopping) {
      try {
        await publishBatch();
        await service.retryReferences();
      } catch {
        log("worker_retry");
      }
      await Bun.sleep(250);
    }
  })(),
]);
metricsServer.stop();
await db.destroy();
