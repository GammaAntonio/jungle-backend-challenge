import { test, expect } from "bun:test";
import {
  resolveCorrelationId,
  withCorrelation,
} from "../../src/application/correlation";

test("A03 correlation accepts bounded safe IDs and replaces missing or invalid headers", () => {
  expect(resolveCorrelationId("provider:request-42")).toBe(
    "provider:request-42",
  );
  for (const value of [
    undefined,
    "",
    "bad id",
    "x".repeat(129),
    ["one", "two"],
    "bad\r\nheader",
  ])
    expect(resolveCorrelationId(value)).toMatch(/^[a-f0-9-]{36}$/);
});
test("A03 async correlation is isolated across concurrent requests", async () => {
  const a = withCorrelation("request-a", async () => {
    await Promise.resolve();
    return resolveCorrelationId();
  });
  const b = withCorrelation("request-b", async () => {
    await Promise.resolve();
    return resolveCorrelationId();
  });
  expect(await Promise.all([a, b])).toEqual(["request-a", "request-b"]);
});
