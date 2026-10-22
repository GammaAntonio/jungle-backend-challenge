import { test, expect } from "bun:test";
import {
  Money,
  Wallet,
  WagerTransaction,
  WalletLedgerEntry,
} from "../../src/domain/model";
import { payloadHash, requestSchema } from "../../src/application/contracts";
const m = (amount: string, currency = "BRL") =>
  Money.from({ amount, currency });
test("Money exact arithmetic, serialization and immutability", () => {
  const a = m("0.10");
  expect(a.add(m("0.20")).toString()).toBe("0.30");
  expect(a.toString()).toBe("0.10");
  expect(Object.isFrozen(a)).toBe(true);
  expect(m("1.00").subtract(m("2.00")).toString()).toBe("-1.00");
  expect(m("1.00").negate().toString()).toBe("-1.00");
  expect(JSON.stringify(a)).toBe('{"amount":"0.10","currency":"BRL"}');
  expect(m("0.00").isZero()).toBe(true);
});
for (const value of [
  "NaN",
  "Infinity",
  "1e2",
  "",
  "-1.00",
  "1.001",
  "1",
  "01.00",
  "10000000000000000.00",
])
  test(`reject money ${value}`, () => expect(() => m(value)).toThrow());
test("overflow and currency mismatch", () => {
  expect(() => m("9999999999999999.99").add(m("0.01"))).toThrow(
    "MONEY_OVERFLOW",
  );
  expect(() => m("1.00").add(m("1.00", "USD"))).toThrow("CURRENCY_MISMATCH");
  expect(() => m("1.00", "XYZ")).toThrow();
});
test("Wallet does not overdraw and increments version only for changed balance", () => {
  const w = Wallet.open({
    id: "wallet",
    playerId: "player",
    initialBalance: m("100.00"),
  });
  w.debit(m("80.00"));
  expect(w.balance.toString()).toBe("20.00");
  expect(w.version).toBe(2);
  expect(() => w.debit(m("80.00"))).toThrow("INSUFFICIENT_FUNDS");
  w.credit(m("0.00"));
  expect(w.version).toBe(2);
  expect(() => w.credit(m("1.00", "USD"))).toThrow();
});
test("terminal states cannot transition", () => {
  for (const state of ["PROCESSED", "REJECTED", "FAILED"] as const) {
    const t = WagerTransaction.rehydrate({
      id: "t",
      kind: "BET",
      status: state,
    });
    expect(() => t.markProcessed()).toThrow("INVALID_TRANSACTION_STATE");
    expect(() => t.reject("X")).toThrow();
  }
  expect(() => WagerTransaction.create("x", "REFUND")).toThrow(
    "REFERENCE_REQUIRED",
  );
});
test("ledger factory verifies arithmetic", () => {
  expect(() =>
    WalletLedgerEntry.create({
      direction: "DEBIT",
      money: m("2.00"),
      balanceBefore: m("3.00"),
      balanceAfter: m("2.00"),
    }),
  ).toThrow();
  const e = WalletLedgerEntry.create({
    direction: "DEBIT",
    money: m("2.00"),
    balanceBefore: m("3.00"),
    balanceAfter: m("1.00"),
  });
  expect(e.isBalanced()).toBe(true);
  expect(Object.isFrozen(e)).toBe(true);
});
test("canonical hash sorted recursively; distinct business data conflicts", () => {
  expect(payloadHash({ b: 1, a: { d: 2, c: 3 } })).toBe(
    payloadHash({ a: { c: 3, d: 2 }, b: 1 }),
  );
  expect(payloadHash({ amount: "1.00" })).not.toBe(
    payloadHash({ amount: "2.00" }),
  );
});
test("OPENING never accepted externally", () => {
  expect(requestSchema.safeParse({ kind: "OPENING" }).success).toBe(false);
});
import { InboxMessage, OutboxMessage } from "../../src/domain/messages";
import { WalletBalanceChanged } from "../../src/domain/events";
for (const [kind, referenceKind, expected] of [
  ["BET", undefined, "DEBIT"],
  ["WIN", undefined, "CREDIT"],
  ["LOSS", undefined, undefined],
  ["REFUND", "BET", "CREDIT"],
  ["ROLLBACK", "BET", "CREDIT"],
  ["ROLLBACK", "WIN", "DEBIT"],
  ["ROLLBACK", "REFUND", "DEBIT"],
] as const)
  test(`direction ${kind} / ${referenceKind}`, () => {
    const t = WagerTransaction.create(
      "t",
      kind,
      referenceKind ? "ref" : undefined,
    );
    const ref = referenceKind
      ? WagerTransaction.rehydrate({
          id: "ref",
          kind: referenceKind,
          status: "PROCESSED",
        })
      : undefined;
    expect(t.ledgerDirectionFor(ref)).toBe(expected);
  });
test("Inbox factories and explicit transition", () => {
  const inbox = InboxMessage.receive({
    messageId: "m",
    consumerName: "c",
    payloadHash: "h",
  });
  expect(inbox.isProcessed()).toBe(false);
  inbox.markProcessed(new Date());
  expect(inbox.isProcessed()).toBe(true);
  expect(() => inbox.markProcessed(new Date())).toThrow();
  expect(
    InboxMessage.rehydrate({
      messageId: "m",
      consumerName: "c",
      payloadHash: "h",
      receivedAt: new Date(),
      processedAt: new Date(),
    }).isProcessed(),
  ).toBe(true);
});
test("Versioned event JSON and outbox retry backoff", () => {
  const event = WalletBalanceChanged.from(
    { aggregateId: "w", correlationId: "c" },
    {
      walletId: "w",
      transactionId: "t",
      direction: "CREDIT",
      money: m("1.00").toJSON(),
      balanceBefore: m("0.00").toJSON(),
      balanceAfter: m("1.00").toJSON(),
      walletVersion: 1,
    },
  );
  const outbox = OutboxMessage.enqueue(event);
  expect(event.toJSON().version).toBe(1);
  expect(event.toJSON().eventType).toBe("WalletBalanceChanged");
  expect(JSON.parse(JSON.stringify(event)).data.money.amount).toBe("1.00");
  const now = new Date();
  outbox.scheduleRetry(now);
  expect(outbox.attempts).toBe(1);
  expect(outbox.isDue(now)).toBe(false);
  expect(outbox.nextAttemptAt!.getTime() - now.getTime()).toBe(2000);
  outbox.markPublished(now);
  expect(outbox.isPending()).toBe(false);
});
