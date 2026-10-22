import { expect, test } from "bun:test";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
  parseIntegrationEvent,
  type StoredIntegrationEvent,
} from "../../src/domain/events";
import { Money } from "../../src/domain/model";
import { OutboxMessage } from "../../src/domain/messages";
import legacy from "../fixtures/events-v1-legacy.json";

const ctx = {
  aggregateId: "wallet",
  correlationId: "correlation",
  causationId: "message",
};
const money = { amount: "25.00", currency: "BRL" };
const transaction = {
  transactionId: "transaction",
  kind: "BET" as const,
  balance: money,
};
const changed = {
  walletId: "wallet",
  transactionId: "transaction",
  direction: "DEBIT" as const,
  money,
  balanceBefore: { amount: "100.00", currency: "BRL" },
  balanceAfter: { amount: "75.00", currency: "BRL" },
  walletVersion: 2,
};
const cases = [
  WagerTransactionProcessed.from(ctx, { ...transaction, status: "PROCESSED" }),
  WagerTransactionRejected.from(ctx, {
    ...transaction,
    status: "REJECTED",
    failureCode: "INSUFFICIENT_FUNDS",
  }),
  WagerTransactionPendingReference.from(ctx, {
    ...transaction,
    status: "PENDING_REFERENCE",
  }),
  WalletBalanceChanged.from(ctx, changed),
];
for (const event of cases) {
  test(`AR02 complete ${event.eventType} envelope is stable v1 JSON`, () => {
    const first = JSON.stringify(event);
    const value: unknown = JSON.parse(first);
    const parsed = parseIntegrationEvent(value);
    expect(parsed).toEqual(event.toJSON());
    expect(parsed.eventType).toBe(event.eventType);
    expect(parsed.version).toBe(1);
    expect(parsed.eventId).toBe(event.eventId);
    expect(parsed.aggregateId).toBe(ctx.aggregateId);
    expect(parsed.correlationId).toBe(ctx.correlationId);
    expect(parsed.causationId).toBe(ctx.causationId);
    expect(parsed.occurredAt).toBe(event.occurredAt.toISOString());
    expect(new Date(parsed.occurredAt).toISOString()).toBe(parsed.occurredAt);
    expect(JSON.stringify(event)).toBe(first);
    expect(parseIntegrationEvent(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
    expect(OutboxMessage.enqueue(event).payload).toEqual(parsed);
  });
}

test("AR02 causationId remains optional and no status is added to legacy OPENING", () => {
  const event = WagerTransactionProcessed.from(
    { aggregateId: "w", correlationId: "c" },
    { ...transaction, kind: "OPENING" },
  );
  expect(JSON.parse(JSON.stringify(event))).not.toHaveProperty("causationId");
  expect(JSON.parse(JSON.stringify(event)).data).not.toHaveProperty("status");
  expect(parseIntegrationEvent(event.toJSON()).correlationId).toBe("c");
});

test("AR02 event serialization snapshots input and exposes MoneyProps without bigint or model instances", () => {
  const data = structuredClone(changed);
  const context = { ...ctx };
  const event = WalletBalanceChanged.from(context, data);
  const before = JSON.stringify(event);
  data.money.amount = "99.00";
  context.correlationId = "other";
  event.occurredAt.setFullYear(2000);
  expect(JSON.stringify(event)).toBe(before);
  expect(event.data.money).not.toBeInstanceOf(Money);
  expect(Object.isFrozen(event.data.money)).toBe(true);
  const inspect = (v: unknown): void => {
    expect(typeof v).not.toBe("bigint");
    expect(v).not.toBeInstanceOf(Money);
    if (v && typeof v === "object")
      for (const item of Object.values(v)) inspect(item);
  };
  inspect(event.toJSON());
});

test("AR02 reconstruction rejects missing mandatory payload fields for all four events", () => {
  for (const event of cases) {
    const json = JSON.parse(JSON.stringify(event));
    for (const field of Object.keys(json.data)) {
      if (event.eventType === "WagerTransactionProcessed" && field === "status")
        continue;
      const invalid = structuredClone(json);
      delete invalid.data[field];
      expect(() => parseIntegrationEvent(invalid)).toThrow();
    }
  }
});

test("AR02 runtime rejects Money instances and noncanonical monetary JSON at the factory boundary", () => {
  const invalid: unknown[] = [
    Money.from(money),
    { amount: 25, currency: "BRL" },
    { amount: 2500n, currency: "BRL" },
    { amount: "25.001", currency: "BRL" },
    { amount: "1e2", currency: "BRL" },
    { amount: "NaN", currency: "BRL" },
    { amount: "-1.00", currency: "BRL" },
    { amount: "1.00", currency: "XYZ" },
  ];
  for (const value of invalid) {
    // Deliberately emulate untyped external callers; production remains strictly typed.
    expect(() =>
      Reflect.apply(WalletBalanceChanged.from, WalletBalanceChanged, [
        ctx,
        { ...changed, money: value },
      ]),
    ).toThrow();
    expect(() =>
      parseIntegrationEvent({
        ...cases[3].toJSON(),
        data: { ...changed, money: value },
      }),
    ).toThrow();
  }
});

test("AR02 reconstruction rejects invalid headers, wrong event data, unknown versions and extras", () => {
  const valid = cases[0].toJSON();
  for (const patch of [
    { version: 2 },
    { occurredAt: "yesterday" },
    { correlationId: "" },
    { eventId: undefined },
    { aggregateId: undefined },
    { eventType: "UnknownEvent" },
    { data: changed },
    { unexpected: "field" },
  ]) {
    expect(() => parseIntegrationEvent({ ...valid, ...patch })).toThrow();
  }
});

test("AR02 original persisted v1 fixtures reconstruct without migration or metadata changes", () => {
  for (const raw of legacy) {
    const parsed = parseIntegrationEvent(raw);
    expect<unknown>(parsed).toEqual(raw);
    const message = OutboxMessage.rehydrate({
      id: raw.eventId,
      aggregateId: raw.aggregateId,
      eventType: raw.eventType,
      payload: raw,
      occurredAt: new Date(raw.occurredAt),
      attempts: 3,
    });
    expect<unknown>(message.payload).toEqual(raw);
    expect(message.attempts).toBe(3);
  }
  expect(legacy[0].data).not.toHaveProperty("status");
});

test("AR02 outbox reconstruction rejects payload-column identity mismatches", () => {
  const raw: StoredIntegrationEvent = parseIntegrationEvent(legacy[0]);
  const row = {
    id: raw.eventId,
    aggregateId: raw.aggregateId,
    eventType: raw.eventType,
    payload: raw,
    occurredAt: new Date(raw.occurredAt),
    attempts: 0,
  };
  for (const patch of [
    { id: "other" },
    { aggregateId: "other" },
    { eventType: "WalletBalanceChanged" },
  ]) {
    expect(() => OutboxMessage.rehydrate({ ...row, ...patch })).toThrow(
      "OUTBOX_EVENT_IDENTITY_MISMATCH",
    );
  }
});
