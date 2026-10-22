import {
  aggregateMetrics,
  type MetricsSnapshot,
} from "../src/infrastructure/metrics";
const urls = process.argv.slice(2);
if (!urls.length) throw Error("Pass each API/worker /metrics URL");
const samples: MetricsSnapshot[] = await Promise.all(
  urls.map(async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error("METRICS_ENDPOINT_UNAVAILABLE");
    return response.json();
  }),
);
console.log(JSON.stringify(aggregateMetrics(samples), null, 2));
