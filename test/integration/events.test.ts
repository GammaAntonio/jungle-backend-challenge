import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { setup, cleanup, service, wallet, bet } from "../support";
import { db } from "../../src/infrastructure/db";
import {
  initQueues,
  queueNames,
  queueUrl,
  send,
  sqs,
} from "../../src/infrastructure/sqs";
import { publishBatch } from "../../src/infrastructure/outbox";
import { consumeOnce } from "../../src/infrastructure/consumer";
import {
  parseIntegrationEvent,
  type StoredIntegrationEvent,
} from "../../src/domain/events";
import legacy from "../fixtures/events-v1-legacy.json";

beforeAll(async () => {
  await setup();
  await initQueues();
});
afterAll(cleanup);

async function eventsFor(id: string) {
  const rows: { payload: unknown }[] = await db.query(
    "SELECT payload FROM outbox WHERE payload->'data'->>'transactionId'=$1 ORDER BY occurred_at,id",
    [id],
  );
  return rows.map((row) => parseIntegrationEvent(row.payload));
}
test("AR02 real financial producers persist complete events for OPENING BET WIN LOSS REFUND ROLLBACK rejection and pending reference", async () => {
  const w = await wallet();
  const b = bet(w);
  const ctx = () => ({
    correlationId: "ar02-producer",
    messageId: crypto.randomUUID(),
  });
  const firstContext = ctx();
  const first = await service.submit(b, "ar02-bet", firstContext);
  const win = await service.submit(
    bet(w, "10.00", { kind: "WIN" }),
    "ar02-win",
    ctx(),
  );
  const loss = await service.submit(
    bet(w, "0.00", { kind: "LOSS" }),
    "ar02-loss",
    ctx(),
  );
  const refundBody = bet(w, "25.00", {
    kind: "REFUND",
    referenceExternalTransactionId: b.externalTransactionId,
  });
  const refund = await service.submit(refundBody, "ar02-refund", ctx());
  const rollback = await service.submit(
    bet(w, "25.00", {
      kind: "ROLLBACK",
      referenceExternalTransactionId: refundBody.externalTransactionId,
    }),
    "ar02-rollback",
    ctx(),
  );
  const rejected = await service.submit(
    bet(w, "999.00"),
    "ar02-rejected",
    ctx(),
  );
  const later = bet(w);
  const pending = await service.submit(
    bet(w, "25.00", {
      kind: "REFUND",
      referenceExternalTransactionId: later.externalTransactionId,
    }),
    "ar02-pending",
    ctx(),
  );

  for (const result of [first, win, refund, rollback]) {
    const events = await eventsFor(result.transactionId);
    expect<string[]>(events.map((e) => e.eventType).sort()).toEqual(
      ["WagerTransactionProcessed", "WalletBalanceChanged"].sort(),
    );
    for (const event of events) {
      expect(event.version).toBe(1);
      expect(event.correlationId).toBe("ar02-producer");
      expect(event.causationId).toBeString();
      expect(new Date(event.occurredAt).toISOString()).toBe(event.occurredAt);
      if (event.eventType === "WalletBalanceChanged") {
        expect(event.data.walletId).toBe(w.id);
        expect(event.data.money.amount).toMatch(/^\d+\.\d{2}$/);
        expect(event.data.money.currency).toBe("BRL");
        expect(event.data.balanceBefore.amount).toBeString();
        expect(event.data.balanceAfter.amount).toBe(result.balance.amount);
        expect(event.data.walletVersion).toBeNumber();
      }
    }
  }
  expect(
    (await eventsFor(first.transactionId)).every(
      (e) => e.causationId === firstContext.messageId,
    ),
  ).toBe(true);
  expect((await eventsFor(loss.transactionId)).map((e) => e.eventType)).toEqual(
    ["WagerTransactionProcessed"],
  );
  const rejection = (await eventsFor(rejected.transactionId))[0];
  expect(rejection.eventType).toBe("WagerTransactionRejected");
  if (rejection.eventType !== "WagerTransactionRejected")
    throw Error("WRONG_REJECTION_EVENT");
  expect(rejection.data.failureCode).toBe("INSUFFICIENT_FUNDS");
  const initialPending = (await eventsFor(pending.transactionId))[0];
  expect(initialPending.eventType).toBe("WagerTransactionPendingReference");
  if (initialPending.eventType !== "WagerTransactionPendingReference")
    throw Error("WRONG_PENDING_EVENT");
  expect(initialPending.data.status).toBe("PENDING_REFERENCE");
  const openingRows: { payload: unknown }[] = await db.query(
    "SELECT payload FROM outbox WHERE aggregate_id=$1 AND payload->'data'->>'kind'='OPENING'",
    [w.id],
  );
  expect(openingRows.length).toBe(1);
  expect(parseIntegrationEvent(openingRows[0].payload).data).not.toHaveProperty(
    "status",
  );

  await service.submit(later, "ar02-later");
  await db.query(
    "UPDATE wager_transaction SET next_attempt_at=now() WHERE id=$1",
    [pending.transactionId],
  );
  await service.retryReferences();
  expect<string[]>(
    (await eventsFor(pending.transactionId)).map((e) => e.eventType).sort(),
  ).toEqual(
    [
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ].sort(),
  );
  expect((await service.reconcile(w.id)).consistent).toBe(true);
  expect((await service.wallet(w.id)).balance.amount).toBe("85.00");
});

test("AR02 real SQS consumer deduplicates and publisher delivers validated current and original v1 payloads", async () => {
  const w = await wallet();
  const b = bet(w);
  const messageId = crypto.randomUUID();
  const request = {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: { ...b, idempotencyKey: "ar02-sqs" },
  };
  await send(queueNames.requests, request, w.id, messageId);
  expect(await consumeOnce(service)).toBe(1);
  const [transaction] = await db.query(
    "SELECT id FROM wager_transaction WHERE wallet_id=$1 AND kind='BET'",
    [w.id],
  );
  const before = await eventsFor(transaction.id);
  expect(before.length).toBe(2);
  expect(
    before.every(
      (e) => e.correlationId === messageId && e.causationId === messageId,
    ),
  ).toBe(true);
  await send(queueNames.requests, request, w.id, messageId + "-redelivery");
  expect(await consumeOnce(service)).toBe(1);
  expect(await eventsFor(transaction.id)).toEqual(before);
  expect((await service.wallet(w.id)).balance.amount).toBe("75.00");
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM ledger WHERE transaction_id=$1",
        [transaction.id],
      )
    )[0].n,
  ).toBe(1);
  expect((await service.reconcile(w.id)).consistent).toBe(true);

  for (const raw of legacy) {
    const event = parseIntegrationEvent(raw);
    await db.query(
      "INSERT INTO outbox(id,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4)",
      [event.eventId, event.aggregateId, event.eventType, raw],
    );
  }
  const rows: { payload: unknown }[] = await db.query(
    "SELECT payload FROM outbox WHERE published_at IS NULL",
  );
  const expected = new Map(
    rows.map((row) => {
      const event = parseIntegrationEvent(row.payload);
      return [event.eventId, event] as const;
    }),
  );
  for (let attempt = 0; attempt < 10; attempt++) {
    await publishBatch();
    if (
      (
        await db.query(
          "SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL",
        )
      )[0].n === 0
    )
      break;
  }
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL",
      )
    )[0].n,
  ).toBe(0);
  const received = new Set<string>();
  const url = await queueUrl(queueNames.events);
  const deadline = Date.now() + 20000;
  while (received.size < expected.size && Date.now() < deadline) {
    const batch = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        WaitTimeSeconds: 1,
        MaxNumberOfMessages: 10,
        MessageSystemAttributeNames: [
          "MessageGroupId",
          "MessageDeduplicationId",
        ],
      }),
    );
    for (const message of batch.Messages ?? []) {
      const event = parseIntegrationEvent(JSON.parse(message.Body!));
      expect(event).toEqual(expected.get(event.eventId)!);
      expect(message.Attributes?.MessageDeduplicationId).toBe(event.eventId);
      expect(message.Attributes?.MessageGroupId).toBe(event.aggregateId);
      received.add(event.eventId);
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: url,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }
  }
  expect(received.size).toBe(expected.size);
  for (const raw of legacy) expect(received.has(raw.eventId)).toBe(true);
});

test("AR02 publisher retains invalid persisted contracts and mismatched identity without publishing them", async () => {
  const valid = parseIntegrationEvent(legacy[4]);
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const invalid = [
    {
      ...valid,
      eventId: ids[0],
      data: { money: { amount: "NaN", currency: "BRL" } },
    },
    { ...valid, eventId: crypto.randomUUID() },
    { ...valid, eventId: ids[2], version: 2 },
  ];
  for (let i = 0; i < ids.length; i++)
    await db.query(
      "INSERT INTO outbox(id,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4)",
      [ids[i], valid.aggregateId, valid.eventType, invalid[i]],
    );
  await publishBatch();
  for (let i = 0; i < ids.length; i++) {
    const [row] = await db.query(
      "SELECT payload,published_at,attempts,next_attempt_at>now() AS backed_off FROM outbox WHERE id=$1",
      [ids[i]],
    );
    expect<unknown>(row.payload).toEqual(invalid[i]);
    expect(row.published_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.backed_off).toBe(true);
  }
  const batch = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: await queueUrl(queueNames.events),
      WaitTimeSeconds: 1,
    }),
  );
  expect(batch.Messages ?? []).toHaveLength(0);
});
