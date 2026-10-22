import { AsyncLocalStorage } from "node:async_hooks";
const context = new AsyncLocalStorage<{ correlationId: string }>();
export function resolveCorrelationId(value?: unknown): string {
  if (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    return value;
  return context.getStore()?.correlationId ?? crypto.randomUUID();
}
export function withCorrelation<T>(correlationId: string, run: () => T): T {
  return context.run(
    { correlationId: resolveCorrelationId(correlationId) },
    run,
  );
}
