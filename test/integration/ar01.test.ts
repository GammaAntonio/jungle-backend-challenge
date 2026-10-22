import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "pg";
import {
  setup,
  cleanup,
  schema,
  runtimeRole,
  runtimeUrl,
  adminUrl,
  service,
  wallet,
  bet,
} from "../support";
import { connectRuntime, db } from "../../src/infrastructure/db";

let runtime: Client;
let admin: Client;
beforeAll(async () => {
  await setup();
  await db.destroy();
  db.setOptions({ url: runtimeUrl });
  await connectRuntime();
  runtime = new Client({
    connectionString: runtimeUrl,
    options: `-c search_path=${schema}`,
  });
  admin = new Client({
    connectionString: adminUrl,
    options: `-c search_path=${schema}`,
  });
  await runtime.connect();
  await admin.connect();
});
afterAll(async () => {
  await runtime?.end();
  await admin?.end();
  if (db.isInitialized) await db.destroy();
  db.setOptions({ url: adminUrl });
  await db.initialize();
  await cleanup();
});

async function source(kind: string) {
  const w = await wallet();
  let transactionId: string;
  if (kind === "OPENING") {
    transactionId = (
      await runtime.query(
        "SELECT id FROM wager_transaction WHERE wallet_id=$1 AND kind='OPENING'",
        [w.id],
      )
    ).rows[0].id;
  } else if (kind === "REFUND" || kind === "ROLLBACK") {
    const reference = bet(w, "25.00", {
      kind: kind === "REFUND" ? "BET" : "WIN",
    });
    await service.submit(reference, crypto.randomUUID());
    transactionId = (
      await service.submit(
        bet(w, "25.00", {
          kind,
          referenceExternalTransactionId: reference.externalTransactionId,
        }),
        crypto.randomUUID(),
      )
    ).transactionId;
  } else {
    transactionId = (
      await service.submit(bet(w, "25.00", { kind }), crypto.randomUUID())
    ).transactionId;
  }
  const entry = (
    await runtime.query(
      "SELECT transaction_id,direction,amount::text FROM ledger WHERE transaction_id=$1",
      [transactionId],
    )
  ).rows[0] as {
    transaction_id: string;
    direction: string;
    amount: string;
  };
  return { w, entry };
}

async function attemptedEntry(
  walletId: string,
  transactionId: string,
  direction: string,
  amount: string,
) {
  await runtime.query("BEGIN");
  try {
    const before = (
      await runtime.query("SELECT balance::text FROM wallet WHERE id=$1", [
        walletId,
      ])
    ).rows[0].balance as string;
    const after = (
      await runtime.query(
        "UPDATE wallet SET balance=balance+CASE WHEN $2='CREDIT' THEN $3::numeric ELSE -$3::numeric END,version=version+1 WHERE id=$1 RETURNING balance::text",
        [walletId, direction, amount],
      )
    ).rows[0].balance as string;
    await runtime.query(
      "INSERT INTO ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after) VALUES($1,$2,$3,$4,$5,'BRL',$6,$7)",
      [
        crypto.randomUUID(),
        walletId,
        transactionId,
        direction,
        amount,
        before,
        after,
      ],
    );
    await runtime.query("COMMIT");
    return { code: "00000", constraint: undefined };
  } catch (e) {
    await runtime.query("ROLLBACK");
    const error = e as { code: string; constraint?: string };
    return { code: error.code, constraint: error.constraint };
  }
}

test("AR01 valid financial operations and replay use runtime and matching transaction-wallet ledger", async () => {
  expect((await db.query("SELECT current_user"))[0].current_user).toBe(
    runtimeRole,
  );
  const w = await wallet();
  const original = bet(w);
  await service.submit(original, "ar01-valid-bet");
  const win = await service.submit(
    bet(w, "10.00", { kind: "WIN" }),
    "ar01-valid-win",
  );
  expect(win.balance.amount).toBe("85.00");
  const loss = await service.submit(
    bet(w, "0.00", { kind: "LOSS" }),
    "ar01-valid-loss",
  );
  const refundBody = bet(w, "25.00", {
    kind: "REFUND",
    referenceExternalTransactionId: original.externalTransactionId,
  });
  const refund = await service.submit(refundBody, "ar01-valid-refund");
  expect(refund.balance.amount).toBe("110.00");
  const rollback = await service.submit(
    bet(w, "25.00", {
      kind: "ROLLBACK",
      referenceExternalTransactionId: refundBody.externalTransactionId,
    }),
    "ar01-valid-rollback",
  );
  expect(rollback.balance.amount).toBe("85.00");
  const replay = await service.submit(original, "ar01-valid-bet");
  expect(replay.idempotentReplay).toBe(true);
  expect(replay.balance.amount).toBe("75.00");
  const entries = await runtime.query(
    "SELECT t.kind,t.wallet_id=l.wallet_id AS matches FROM ledger l JOIN wager_transaction t ON t.id=l.transaction_id WHERE l.wallet_id=$1 ORDER BY l.sequence",
    [w.id],
  );
  expect(entries.rows.map((r) => r.kind)).toEqual([
    "OPENING",
    "BET",
    "WIN",
    "REFUND",
    "ROLLBACK",
  ]);
  expect(entries.rows.every((r) => r.matches)).toBe(true);
  expect(
    (
      await runtime.query("SELECT id FROM ledger WHERE transaction_id=$1", [
        loss.transactionId,
      ])
    ).rowCount,
  ).toBe(0);
  expect((await service.reconcile(w.id)).consistent).toBe(true);
  expect((await service.wallet(w.id)).version).toBe(5);
});

for (const kind of ["OPENING", "BET", "WIN", "REFUND", "ROLLBACK"]) {
  test(`AR01 runtime rejects cross-wallet ${kind} ledger with 23503 and rolls back balance`, async () => {
    const { w, entry } = await source(kind);
    const target = await wallet();
    const beforeSource = await service.wallet(w.id);
    const beforeTarget = await service.wallet(target.id);
    const error = await attemptedEntry(
      target.id,
      entry.transaction_id,
      entry.direction,
      entry.amount,
    );
    expect(error.code).toBe("23503");
    expect(error.constraint).toBe("ledger_transaction_wallet_fk");
    expect(await service.wallet(w.id)).toEqual(beforeSource);
    expect(await service.wallet(target.id)).toEqual(beforeTarget);
    expect(
      (
        await runtime.query("SELECT id FROM ledger WHERE transaction_id=$1", [
          entry.transaction_id,
        ])
      ).rowCount,
    ).toBe(1);
    expect((await service.reconcile(w.id)).consistent).toBe(true);
    expect((await service.reconcile(target.id)).checkedEntries).toBe(1);
    expect((await service.reconcile(target.id)).consistent).toBe(true);
  });
}

test("AR01 runtime still rejects missing transaction with 23503 and no balance change", async () => {
  const w = await wallet();
  const before = await service.wallet(w.id);
  expect(
    (await attemptedEntry(w.id, crypto.randomUUID(), "CREDIT", "10.00")).code,
  ).toBe("23503");
  expect(await service.wallet(w.id)).toEqual(before);
  expect((await service.reconcile(w.id)).consistent).toBe(true);
});

test("AR01 runtime still rejects duplicate ledger on the same wallet with 23505", async () => {
  const { w, entry } = await source("WIN");
  const before = await service.wallet(w.id);
  expect(
    (
      await attemptedEntry(
        w.id,
        entry.transaction_id,
        entry.direction,
        entry.amount,
      )
    ).code,
  ).toBe("23505");
  expect(await service.wallet(w.id)).toEqual(before);
  expect((await service.reconcile(w.id)).consistent).toBe(true);
});

async function snapshot() {
  const state: Record<string, unknown> = {};
  for (const table of [
    "wallet",
    "wager_transaction",
    "ledger",
    "inbox",
    "outbox",
  ]) {
    state[table] = (
      await admin.query(`SELECT * FROM ${table} ORDER BY 1`)
    ).rows;
  }
  return state;
}

test("AR01 migration 003 down and up preserve existing financial history and restore validated composite FK", async () => {
  const before = await snapshot();
  await admin.query("BEGIN");
  try {
    await admin.query(await Bun.file("migrations/003.down.sql").text());
    expect(
      (
        await admin.query(
          "SELECT conname FROM pg_constraint WHERE conrelid='ledger'::regclass AND conname='ledger_transaction_wallet_fk'",
        )
      ).rowCount,
    ).toBe(0);
    expect(await snapshot()).toEqual(before);
    await admin.query(await Bun.file("migrations/003.up.sql").text());
    const constraint = (
      await admin.query(
        "SELECT convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='ledger'::regclass AND conname='ledger_transaction_wallet_fk'",
      )
    ).rows[0];
    expect(constraint.convalidated).toBe(true);
    expect(constraint.definition).toContain(
      "FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transaction(id, wallet_id)",
    );
    expect(await snapshot()).toEqual(before);
    await admin.query("COMMIT");
  } catch (e) {
    await admin.query("ROLLBACK");
    throw e;
  }
  expect(
    (
      await admin.query("SELECT version FROM schema_migration ORDER BY version")
    ).rows.map((r) => r.version),
  ).toEqual(["001", "002", "003"]);
});

test("AR01 migration 003 refuses inconsistent existing history with 23503 without deleting or rewriting rows", async () => {
  const isolated = "test_ar01_dirty_" + crypto.randomUUID().replaceAll("-", "");
  await admin.query("BEGIN");
  try {
    await admin.query(`CREATE SCHEMA "${isolated}"`);
    await admin.query(`SET LOCAL search_path TO "${isolated}"`);
    await admin.query(await Bun.file("migrations/001.up.sql").text());
    await admin.query(await Bun.file("migrations/002.up.sql").text());
    const a = crypto.randomUUID(),
      b = crypto.randomUUID(),
      tx = crypto.randomUUID();
    await admin.query(
      "INSERT INTO wallet(id,player_id,currency,balance,version) VALUES($1,$2,'BRL',0,1),($3,$4,'BRL',0,1)",
      [a, crypto.randomUUID(), b, crypto.randomUUID()],
    );
    await admin.query(
      "INSERT INTO wager_transaction(id,provider_id,external_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,request) SELECT $1::uuid,'ar01',$1::text,$1::text,'h',id,player_id,'r','g','WIN',10,'BRL','PROCESSED','{}' FROM wallet WHERE id=$2",
      [tx, a],
    );
    for (const id of [a, b]) {
      await admin.query(
        "INSERT INTO ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after) VALUES($1,$2,$3,'CREDIT',10,'BRL',0,10)",
        [crypto.randomUUID(), id, tx],
      );
      await admin.query("UPDATE wallet SET balance=10,version=2 WHERE id=$1", [
        id,
      ]);
    }
    await admin.query("SET CONSTRAINTS ALL IMMEDIATE");
    const before = await snapshot();
    await admin.query("SAVEPOINT migration_attempt");
    let code = "";
    try {
      await admin.query(await Bun.file("migrations/003.up.sql").text());
    } catch (e) {
      code = (e as { code: string }).code;
    }
    await admin.query("ROLLBACK TO SAVEPOINT migration_attempt");
    expect(code).toBe("23503");
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM ledger l JOIN wager_transaction t ON t.id=l.transaction_id WHERE l.wallet_id<>t.wallet_id",
        )
      ).rows[0].n,
    ).toBe(1);
  } finally {
    await admin.query("ROLLBACK");
  }
});
