import { beforeAll, afterAll, test, expect } from "bun:test";
import { setup, cleanup, wallet, bet, service } from "../support";
import { db, atomic, migrate } from "../../src/infrastructure/db";
import {
  initQueues,
  queueNames,
  send,
  sqs,
  queueUrl,
} from "../../src/infrastructure/sqs";
import { publishBatch } from "../../src/infrastructure/outbox";
import { consumeOnce } from "../../src/infrastructure/consumer";
import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  SetQueueAttributesCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
beforeAll(async () => {
  await setup();
  await initQueues();
});
afterAll(cleanup);
test("opening, ledger, constraints, immutability and no unbacked balance update", async () => {
  const w = await wallet();
  expect(w.version).toBe(1);
  expect((await service.reconcile(w.id)).consistent).toBe(true);
  await expect(
    service.open({
      playerId: w.playerId,
      initialBalance: { amount: "0.00", currency: "BRL" },
    }),
  ).rejects.toThrow("WALLET_EXISTS");
  await expect(
    db.query("UPDATE wallet SET balance=-1 WHERE id=$1", [w.id]),
  ).rejects.toThrow();
  await expect(
    db.query("UPDATE wallet SET balance=1 WHERE id=$1", [w.id]),
  ).rejects.toThrow();
  await expect(
    db.query("DELETE FROM ledger WHERE wallet_id=$1", [w.id]),
  ).rejects.toThrow("immutable");
  await expect(
    db.query("UPDATE ledger SET amount=1 WHERE wallet_id=$1", [w.id]),
  ).rejects.toThrow("immutable");
});
test("BET, WIN, LOSS, REFUND, ROLLBACK, double reversal and original replay balance", async () => {
  const w = await wallet();
  const b = bet(w);
  const r = await service.submit(b, "b" + w.id);
  expect(r.balance.amount).toBe("75.00");
  const win = bet(w, "10.00", {
    kind: "WIN",
    referenceExternalTransactionId: b.externalTransactionId,
  });
  expect((await service.submit(win, "w" + w.id)).balance.amount).toBe("85.00");
  const loss = bet(w, "0.00", { kind: "LOSS" });
  await service.submit(loss, "l" + w.id);
  const refund = bet(w, "25.00", {
    kind: "REFUND",
    referenceExternalTransactionId: b.externalTransactionId,
  });
  expect((await service.submit(refund, "r" + w.id)).balance.amount).toBe(
    "110.00",
  );
  const dup = bet(w, "25.00", {
    kind: "REFUND",
    referenceExternalTransactionId: b.externalTransactionId,
  });
  expect((await service.submit(dup, "dup" + w.id)).failureCode).toBe(
    "ALREADY_REVERSED",
  );
  const rollback = bet(w, "25.00", {
    kind: "ROLLBACK",
    referenceExternalTransactionId: refund.externalTransactionId,
  });
  expect((await service.submit(rollback, "rb" + w.id)).balance.amount).toBe(
    "85.00",
  );
  expect(await service.submit(b, "b" + w.id)).toEqual({
    ...r,
    idempotentReplay: true,
  });
  const [count] = await db.query(
    "SELECT count(*)::int AS n FROM ledger WHERE transaction_id=$1",
    [(await service.submit(loss, "l" + w.id)).transactionId],
  );
  expect(count.n).toBe(0);
  expect((await service.reconcile(w.id)).consistent).toBe(true);
});
test("reference mismatch, amount mismatch, reversal insufficient funds and currency", async () => {
  const w = await wallet();
  const win = bet(w, "100.00", { kind: "WIN" });
  await service.submit(win, "win" + w.id);
  await service.submit(bet(w, "190.00"), "spend" + w.id);
  expect(
    (
      await service.submit(
        bet(w, "100.00", {
          kind: "ROLLBACK",
          referenceExternalTransactionId: win.externalTransactionId,
        }),
        "rollback" + w.id,
      )
    ).failureCode,
  ).toBe("REVERSAL_INSUFFICIENT_FUNDS");
  expect(
    (
      await service.submit(
        bet(w, "99.00", {
          kind: "ROLLBACK",
          referenceExternalTransactionId: win.externalTransactionId,
        }),
        "amount" + w.id,
      )
    ).failureCode,
  ).toBe("REFERENCE_AMOUNT_MISMATCH");
  const other = await wallet();
  expect(
    (
      await service.submit(
        bet(other, "100.00", {
          kind: "ROLLBACK",
          referenceExternalTransactionId: win.externalTransactionId,
        }),
        "other" + w.id,
      )
    ).failureCode,
  ).toBe("REFERENCE_MISMATCH");
  expect(
    (
      await service.submit(
        bet(w, "1.00", { money: { amount: "1.00", currency: "USD" } }),
        "currency" + w.id,
      )
    ).failureCode,
  ).toBe("CURRENCY_MISMATCH");
});
test("out of order reference reprocessed, expiration terminal", async () => {
  const w = await wallet();
  const b = bet(w);
  const refund = bet(w, "25.00", {
    kind: "REFUND",
    referenceExternalTransactionId: b.externalTransactionId,
  });
  const pending = await service.submit(refund, "pending" + w.id);
  expect(pending.status).toBe("PENDING_REFERENCE");
  await service.submit(b, "later" + w.id);
  await db.query(
    "UPDATE wager_transaction SET next_attempt_at=now() WHERE id=$1",
    [pending.transactionId],
  );
  await service.retryReferences();
  expect((await service.transaction(pending.transactionId)).status).toBe(
    "PROCESSED",
  );
  expect((await service.wallet(w.id)).balance.amount).toBe("100.00");
  const missing = await service.submit(
    bet(w, "25.00", {
      kind: "REFUND",
      referenceExternalTransactionId: "absent",
    }),
    "missing" + w.id,
  );
  await db.query(
    "UPDATE wager_transaction SET attempts=12,next_attempt_at=now() WHERE id=$1",
    [missing.transactionId],
  );
  await service.retryReferences();
  expect((await service.transaction(missing.transactionId)).failure_code).toBe(
    "REFERENCE_TIMEOUT",
  );
});
test("SQL rollback includes inbox/outbox/ledger/balance", async () => {
  const w = await wallet();
  const [before] = await db.query("SELECT count(*)::int AS n FROM outbox");
  await expect(
    atomic(async (q) => {
      await q.query("UPDATE wallet SET balance=0 WHERE id=$1", [w.id]);
      await q.query(
        "INSERT INTO outbox(id,aggregate_id,event_type,payload) VALUES($1,$2,'test','{}')",
        [crypto.randomUUID(), w.id],
      );
      throw Error("injected");
    }),
  ).rejects.toThrow("injected");
  expect((await service.wallet(w.id)).balance.amount).toBe("100.00");
  const [after] = await db.query("SELECT count(*)::int AS n FROM outbox");
  expect(after.n).toBe(before.n);
});
test("inbox dedup persists, conflicting message rejected", async () => {
  const w = await wallet();
  const b = bet(w);
  const first = await service.submit(b, "inbox" + w.id, {
    messageId: "msg" + w.id,
  });
  const replay = await service.submit(b, "inbox" + w.id, {
    messageId: "msg" + w.id,
  });
  expect(replay).toEqual({ ...first, idempotentReplay: true });
  await expect(
    service.submit(
      { ...b, money: { amount: "26.00", currency: "BRL" } },
      "inbox" + w.id,
      { messageId: "msg" + w.id },
    ),
  ).rejects.toThrow("INBOX_CONFLICT");
  const [inbox] = await db.query(
    "SELECT count(*)::int AS n FROM inbox WHERE transaction_id=$1",
    [first.transactionId],
  );
  expect(inbox.n).toBe(1);
});
test("two outbox publishers and recovery after send before publish marker", async () => {
  await Promise.all([publishBatch(), publishBatch()]);
  await publishBatch();
  const [remaining] = await db.query(
    "SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL",
  );
  expect(remaining.n).toBe(0);
  const w = await wallet();
  await publishBatch(async () => {
    throw Error("crash after send");
  });
  const [unmarked] = await db.query(
    "SELECT count(*)::int AS n FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL",
    [w.id],
  );
  expect(unmarked.n).toBe(2);
  await db.query(
    "UPDATE outbox SET next_attempt_at=now() WHERE aggregate_id=$1",
    [w.id],
  );
  await publishBatch();
  const [marked] = await db.query(
    "SELECT count(*)::int AS n FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL",
    [w.id],
  );
  expect(marked.n).toBe(0);
});
test("SQS real delivery, commit before ack and redelivery", async () => {
  const w = await wallet();
  const b = bet(w);
  const messageId = crypto.randomUUID();
  await send(
    queueNames.requests,
    {
      messageId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: { ...b, idempotencyKey: "queue" + w.id },
    },
    w.id,
    messageId,
  );
  await consumeOnce(
    service,
    () => false,
    async () => {
      throw Error("after commit");
    },
  );
  expect((await service.wallet(w.id)).balance.amount).toBe("75.00");
  const deadline = Date.now() + 10000;
  let done = false;
  while (Date.now() < deadline && !done) {
    await consumeOnce(service);
    const [r] = await db.query(
      "SELECT count(*)::int AS n FROM inbox WHERE message_id=$1",
      [messageId],
    );
    done = r.n === 1;
  }
  expect(done).toBe(true);
  expect((await service.reconcile(w.id)).consistent).toBe(true);
  expect((await service.wallet(w.id)).balance.amount).toBe("75.00");
});

async function killAtCheckpoint(mode: string) {
  const child = Bun.spawn(
    [process.execPath, "scripts/failure-child.ts", mode],
    { env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  let output = "";
  for (;;) {
    const part = await reader.read();
    if (part.done)
      throw Error(output + (await new Response(child.stderr).text()));
    output += new TextDecoder().decode(part.value);
    if (output.includes("READY_FOR_KILL")) break;
  }
  child.kill();
  await child.exited;
}
test("actual worker process killed after commit; next process redelivers and reconciles", async () => {
  const w = await wallet();
  const b = bet(w);
  const messageId = crypto.randomUUID();
  const url = await queueUrl(queueNames.requests);
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: url,
      Attributes: { VisibilityTimeout: "1" },
    }),
  );
  await send(
    queueNames.requests,
    {
      messageId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: { ...b, idempotencyKey: "killed" + w.id },
    },
    w.id,
    messageId,
  );
  await killAtCheckpoint("consume");
  expect((await service.wallet(w.id)).balance.amount).toBe("75.00");
  expect(await consumeOnce(service)).toBe(1);
  const child = Bun.spawn(
    [process.execPath, "scripts/failure-child.ts", "reconcile"],
    {
      env: { ...process.env, WALLET_ID: w.id },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const report = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(report.consistent).toBe(true);
  expect(report.storedBalance.amount).toBe("75.00");
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: url,
      Attributes: { VisibilityTimeout: "30" },
    }),
  );
});
test("actual publisher killed after send, lease recovery and two independent publishers", async () => {
  const w = await wallet();
  await killAtCheckpoint("publish-crash");
  const [pending] = await db.query(
    "SELECT count(*)::int AS n FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL",
    [w.id],
  );
  expect(pending.n).toBe(2);
  await db.query(
    "UPDATE outbox SET claimed_until=now() WHERE published_at IS NULL",
  );
  const children = [0, 1].map(() =>
    Bun.spawn([process.execPath, "scripts/failure-child.ts", "publish"], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  for (const c of children) {
    const exit = await c.exited;
    if (exit) throw Error(await new Response(c.stderr).text());
  }
  const [left] = await db.query(
    "SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL",
  );
  expect(left.n).toBe(0);
});
test("real SQS poison message reaches DLQ after five receives", async () => {
  const messageId = crypto.randomUUID();
  await send(queueNames.requests, { poison: messageId }, messageId, messageId);
  const url = await queueUrl(queueNames.requests);
  const dlq = await queueUrl(queueNames.dlq);
  const counts: number[] = [];
  const deadline = Date.now() + 15000;
  let received = false;
  while (Date.now() < deadline && !received) {
    const messages = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    for (const m of messages.Messages ?? []) {
      counts.push(Number(m.Attributes?.ApproximateReceiveCount));
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: url,
          ReceiptHandle: m.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    }
    const dead = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 1 }),
    );
    for (const m of dead.Messages ?? []) {
      expect(JSON.parse(m.Body!).poison).toBe(messageId);
      received = true;
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: dlq,
          ReceiptHandle: m.ReceiptHandle,
        }),
      );
    }
  }
  expect(received).toBe(true);
  expect(counts).toEqual([1, 2, 3, 4, 5]);
});
test("HTTP real NestJS API, validation, conflict, pending and business rejection status", async () => {
  const child = Bun.spawn([process.execPath, "src/main.ts"], {
    env: { ...process.env, PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let output = "";
  let port = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done)
        throw Error(output + (await new Response(child.stderr).text()));
      output += new TextDecoder().decode(r.value);
      const line = output.split("\n").find((l) => l.includes("http_listening"));
      if (line) {
        port = JSON.parse(line).port;
        break;
      }
    }
    const base = "http://127.0.0.1:" + port;
    expect((await fetch(base + "/health/ready")).status).toBe(200);
    const w = await wallet();
    const p = bet(w, "80.00");
    const post = (body: unknown, key?: string) =>
      fetch(base + "/wagering/transactions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await post(p)).status).toBe(400);
    expect((await post(p, "http" + w.id)).status).toBe(200);
    expect(
      (
        await post(
          { ...p, money: { amount: "81.00", currency: "BRL" } },
          "http" + w.id,
        )
      ).status,
    ).toBe(409);
    expect((await post(bet(w, "80.00"), "reject" + w.id)).status).toBe(422);
    expect(
      (
        await post(
          bet(w, "5.00", {
            kind: "REFUND",
            referenceExternalTransactionId: "not-here",
          }),
          "pending" + w.id,
        )
      ).status,
    ).toBe(202);
    expect(
      (await fetch(base + "/wallets/" + w.id + "/ledger?limit=0")).status,
    ).toBe(400);
    const page = (await (
      await fetch(base + "/wallets/" + w.id + "/ledger?limit=1")
    ).json()) as { nextCursor: string };
    expect(page.nextCursor).toBeTruthy();
    const second = (await (
      await fetch(
        base + "/wallets/" + w.id + "/ledger?limit=1&cursor=" + page.nextCursor,
      )
    ).json()) as { entries: unknown[] };
    expect(second.entries.length).toBe(1);
    expect((await fetch(base + "/wallets/invalid")).status).toBe(400);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("PostgreSQL connection killed mid transaction rolls back all uncommitted records", async () => {
  const id = crypto.randomUUID();
  await expect(
    atomic(async (q) => {
      await q.query(
        "INSERT INTO wallet(id,player_id,currency,balance,version) VALUES($1,$2,$3,$4,1)",
        [id, crypto.randomUUID(), "BRL", "0.00"],
      );
      await q.query(
        "INSERT INTO outbox(id,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4)",
        [crypto.randomUUID(), id, "injected", {}],
      );
      await q.query("SELECT pg_terminate_backend(pg_backend_pid())");
    }),
  ).rejects.toThrow();
  expect(
    (await db.query("SELECT * FROM wallet WHERE id=$1", [id])).length,
  ).toBe(0);
  expect(
    (await db.query("SELECT * FROM outbox WHERE aggregate_id=$1", [id])).length,
  ).toBe(0);
});
test("real SQS network failure retains committed outbox for healthy publisher", async () => {
  const w = await wallet();
  const child = Bun.spawn(
    [process.execPath, "scripts/failure-child.ts", "publish"],
    {
      env: { ...process.env, SQS_ENDPOINT: "http://127.0.0.1:1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const status = await child.exited;
  expect(status).toBe(0);
  const [r] = await db.query(
    "SELECT count(*)::int AS n FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL AND attempts>0",
    [w.id],
  );
  expect(r.n).toBe(2);
  expect((await service.reconcile(w.id)).consistent).toBe(true);
  await db.query(
    "UPDATE outbox SET next_attempt_at=now() WHERE aggregate_id=$1",
    [w.id],
  );
  await publishBatch();
  expect(
    (
      await db.query(
        "SELECT * FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL",
        [w.id],
      )
    ).length,
  ).toBe(0);
});
test("overflow becomes durable business rejection without ledger", async () => {
  const w = await wallet("9999999999999999.99");
  const r = await service.submit(
    bet(w, "0.01", { kind: "WIN" }),
    "overflow" + w.id,
  );
  expect(r.failureCode).toBe("BALANCE_LIMIT_EXCEEDED");
  expect((await service.reconcile(w.id)).consistent).toBe(true);
});
test("deferred commit failure rolls back wallet, transaction, ledger, inbox and outbox", async () => {
  const w = await wallet();
  const b = bet(w);
  const [before] = await db.query("SELECT count(*)::int AS n FROM outbox");
  await db.query(
    "CREATE FUNCTION injected_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected commit failure'; END $$",
  );
  await db.query(
    "CREATE CONSTRAINT TRIGGER injected_commit_failure AFTER INSERT ON inbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION injected_commit_failure()",
  );
  try {
    await expect(
      service.submit(b, "atomic-" + w.id, { messageId: "atomic-" + w.id }),
    ).rejects.toThrow("injected commit failure");
    expect((await service.wallet(w.id)).balance.amount).toBe("100.00");
    expect(
      (
        await db.query("SELECT * FROM wager_transaction WHERE external_id=$1", [
          b.externalTransactionId,
        ])
      ).length,
    ).toBe(0);
    expect(
      (
        await db.query("SELECT * FROM inbox WHERE message_id=$1", [
          "atomic-" + w.id,
        ])
      ).length,
    ).toBe(0);
    const [after] = await db.query("SELECT count(*)::int AS n FROM outbox");
    expect(after.n).toBe(before.n);
    expect((await service.reconcile(w.id)).checkedEntries).toBe(1);
  } finally {
    await db.query("DROP TRIGGER injected_commit_failure ON inbox");
    await db.query("DROP FUNCTION injected_commit_failure()");
  }
});

test("migrations down and up in isolated schema", async () => {
  await migrate("down");
  await migrate("up");
  const [r] = await db.query("SELECT count(*)::int AS n FROM wallet");
  expect(r.n).toBe(0);
});
