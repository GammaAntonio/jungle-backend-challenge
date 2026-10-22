import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { atomic, db } from "../../src/infrastructure/db";
import { initQueues } from "../../src/infrastructure/sqs";
import { launch } from "../helpers/managed-process";
import { bet, cleanup, schema, service, setup, wallet } from "../support";

interface Entry {
  sequence: string;
  id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: string;
}
interface Page {
  entries: Entry[];
  nextCursor: string | null;
}
const evidence = "docs/audit/manual/logs-paginacao-ledger";
const phase = process.env.PAGINATION_PHASE ?? "regression";
function record(value: unknown) {
  mkdirSync(evidence, { recursive: true });
  appendFileSync(
    `${evidence}/${phase}.jsonl`,
    JSON.stringify({ at: new Date().toISOString(), schema, ...Object(value) }) +
      "\n",
  );
}
let api: ReturnType<typeof launch> | undefined;
let base: string;
let auditWallet: Awaited<ReturnType<typeof wallet>>;
let tiedWallet: Awaited<ReturnType<typeof wallet>>;
async function request(path: string, method = "GET") {
  const started = performance.now();
  const response = await fetch(base + path, { method });
  const raw = await response.text();
  record({
    request: { method, url: base + path },
    status: response.status,
    response: raw,
    durationMs: performance.now() - started,
  });
  return { status: response.status, body: JSON.parse(raw) };
}
async function sqlEntries(id: string): Promise<Entry[]> {
  const rows = await db.query(
    "SELECT l.sequence::text,l.id,l.transaction_id,l.direction,l.amount,l.currency,l.balance_before,l.balance_after,l.created_at FROM ledger l WHERE l.wallet_id=$1 ORDER BY l.sequence",
    [id],
  );
  return JSON.parse(JSON.stringify(rows));
}
async function traverse(id: string, limit: number) {
  const pages: Page[] = [];
  const entries: Entry[] = [];
  let cursor: string | null = null;
  const cursors = new Set<string>();
  do {
    const path = `/wallets/${id}/ledger?limit=${limit}${
      cursor ? "&cursor=" + encodeURIComponent(cursor) : ""
    }`;
    const r = await request(path);
    expect(r.status).toBe(200);
    const page = r.body as Page;
    expect(page.entries.length).toBeLessThanOrEqual(limit);
    entries.push(...page.entries);
    pages.push(page);
    cursor = page.nextCursor;
    if (cursor !== null) {
      expect(typeof cursor).toBe("string");
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return { entries, pages };
}
beforeAll(async () => {
  await setup();
  await initQueues();
  // Recreate the audit's decimal-width boundary without touching its records.
  for (let i = 0; i < 7; i++) await wallet("1.00");
  auditWallet = await wallet();
  const b = bet(auditWallet);
  await service.submit(b, crypto.randomUUID());
  const refund = bet(auditWallet, "25.00", {
    kind: "REFUND",
    referenceExternalTransactionId: b.externalTransactionId,
  });
  await service.submit(refund, crypto.randomUUID());
  await service.submit(
    bet(auditWallet, "25.00", {
      kind: "ROLLBACK",
      referenceExternalTransactionId: refund.externalTransactionId,
    }),
    crypto.randomUUID(),
  );
  const win = bet(auditWallet, "5.00", { kind: "WIN" });
  await service.submit(win, crypto.randomUUID());
  await service.submit(
    bet(auditWallet, "5.00", {
      kind: "ROLLBACK",
      referenceExternalTransactionId: win.externalTransactionId,
    }),
    crypto.randomUUID(),
  );
  await service.submit(
    bet(auditWallet, "25.00", {
      kind: "ROLLBACK",
      referenceExternalTransactionId: b.externalTransactionId,
    }),
    crypto.randomUUID(),
  );
  tiedWallet = await wallet("0.00");
  // All INSERT defaults use the same PostgreSQL transaction timestamp. Seed
  // balanced, constraint-checked history; never UPDATE existing ledger rows.
  await atomic(async (q) => {
    for (let i = 0; i < 105; i++) {
      const p = bet(tiedWallet, "0.01", { kind: "WIN" });
      await q.query(
        "WITH t AS (INSERT INTO wager_transaction(id,provider_id,external_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,request,processed_at) VALUES($1,'pagination-fixture',$2,$2,'fixture',$3,$4,'round-a','game-a','WIN','0.01','BRL','PROCESSED',$5,now()) RETURNING id), w AS (UPDATE wallet SET balance=balance+0.01,version=version+1,updated_at=now() WHERE id=$3 RETURNING balance) INSERT INTO ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after) SELECT $6,$3,t.id,'CREDIT','0.01','BRL',w.balance-0.01,w.balance FROM t,w",
        [
          crypto.randomUUID(),
          p.externalTransactionId,
          tiedWallet.id,
          tiedWallet.playerId,
          p,
          crypto.randomUUID(),
        ],
      );
    }
  });
  api = launch("src/main.ts", { PORT: "0" });
  base = "http://127.0.0.1:" + (await api.port("http_listening"));
  record({ event: "fixture", auditWallet, tiedWallet, pid: api.child.pid });
});
afterAll(async () => {
  await api?.stop();
  await cleanup();
});

test("ledger pagination audit sequences 8 through 14 are all reachable over HTTP", async () => {
  const expected = await sqlEntries(auditWallet.id);
  const actual = await traverse(auditWallet.id, 2);
  const before = await service.wallet(auditWallet.id);
  const reconciliation = await request(
    `/wallets/${auditWallet.id}/reconciliation`,
    "POST",
  );
  record({
    event: "audit-reproduction",
    walletId: auditWallet.id,
    expected,
    actual,
    omitted: expected.filter((e) => !actual.entries.some((a) => a.id === e.id)),
    reconciliation,
  });
  expect(expected.map((e) => e.sequence)).toEqual([
    "8",
    "9",
    "10",
    "11",
    "12",
    "13",
    "14",
  ]);
  expect(actual.entries).toEqual(expected);
  expect(new Set(actual.entries.map((e) => e.id)).size).toBe(7);
  expect(before.balance.amount).toBe("100.00");
  expect(reconciliation.status).toBe(201);
  expect(reconciliation.body.consistent).toBe(true);
  expect(reconciliation.body.checkedEntries).toBe(7);
});

test.each([1, 2, 3, 7, 50, 100])(
  "ledger pagination limit %i preserves 105 entries with equal timestamps",
  async (limit) => {
    const expected = await sqlEntries(tiedWallet.id);
    expect(expected.length).toBe(105);
    expect(new Set(expected.map((e) => e.created_at)).size).toBe(1);
    expect(expected.some((e) => e.sequence === "99")).toBe(true);
    expect(expected.some((e) => e.sequence === "100")).toBe(true);
    const before = await service.wallet(tiedWallet.id);
    const actual = await traverse(tiedWallet.id, limit);
    record({ event: "tied-timestamps", limit, expected, actual });
    expect(actual.entries).toEqual(expected);
    expect(new Set(actual.entries.map((e) => e.id)).size).toBe(105);
    expect(actual.pages.length).toBe(Math.ceil(105 / limit));
    expect(await sqlEntries(tiedWallet.id)).toEqual(expected);
    expect(await service.wallet(tiedWallet.id)).toEqual(before);
    expect(before.balance.amount).toBe("1.05");
    expect(before.version).toBe(106);
    const r = await request(`/wallets/${tiedWallet.id}/reconciliation`, "POST");
    expect(r.status).toBe(201);
    expect(r.body.consistent).toBe(true);
    expect(r.body.checkedEntries).toBe(105);
  },
);

test("ledger pagination cursor is repeatable wallet-bound and independent of page size", async () => {
  const first = await request(`/wallets/${tiedWallet.id}/ledger?limit=2`);
  const cursor = (first.body as Page).nextCursor!;
  expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  const path = `/wallets/${tiedWallet.id}/ledger?limit=50&cursor=${encodeURIComponent(cursor)}`;
  const a = await request(path);
  const b = await request(path);
  expect(a.status).toBe(200);
  expect(b.body).toEqual(a.body);
  expect((a.body as Page).entries).toEqual(
    (await sqlEntries(tiedWallet.id)).slice(2, 52),
  );
  for (const invalid of ["invalid", cursor]) {
    const w = invalid === cursor ? auditWallet : tiedWallet;
    expect(
      (await request(`/wallets/${w.id}/ledger?cursor=${invalid}`)).status,
    ).toBe(400);
  }
  const invalidTokens = [
    Buffer.from(
      JSON.stringify({ walletId: tiedWallet.id, sequence: ["8"] }),
    ).toString("base64url"),
    Buffer.from(
      JSON.stringify({ walletId: tiedWallet.id, sequence: "-1" }),
    ).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        walletId: tiedWallet.id,
        sequence: "9223372036854775808",
      }),
    ).toString("base64url"),
    Buffer.from(
      JSON.stringify({ walletId: tiedWallet.id, sequence: "08" }),
    ).toString("base64url"),
  ];
  for (const invalidToken of invalidTokens) {
    const response = await request(
      `/wallets/${tiedWallet.id}/ledger?cursor=${encodeURIComponent(invalidToken)}`,
    );
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ code: "INVALID_CURSOR" });
  }
  const repeatedCursor = await request(
    `/wallets/${tiedWallet.id}/ledger?cursor=${encodeURIComponent(cursor)}&cursor=${encodeURIComponent(cursor)}`,
  );
  expect(repeatedCursor.status).toBe(400);
  expect(repeatedCursor.body).toEqual({ code: "INVALID_CURSOR" });
  for (const limit of [0, 101]) {
    expect(
      (await request(`/wallets/${tiedWallet.id}/ledger?limit=${limit}`)).status,
    ).toBe(400);
  }
});

test("ledger pagination appends between pages without repeating previous entries", async () => {
  const w = await wallet("0.00");
  for (let i = 0; i < 3; i++)
    await service.submit(bet(w, "0.01", { kind: "WIN" }), crypto.randomUUID());
  const first = await request(`/wallets/${w.id}/ledger?limit=2`);
  await service.submit(bet(w, "0.01", { kind: "WIN" }), crypto.randomUUID());
  const last = await request(
    `/wallets/${w.id}/ledger?limit=2&cursor=${(first.body as Page).nextCursor}`,
  );
  const combined = [
    ...(first.body as Page).entries,
    ...(last.body as Page).entries,
  ];
  expect(last.status).toBe(200);
  expect((last.body as Page).nextCursor).toBeNull();
  expect(combined).toEqual(await sqlEntries(w.id));
  expect(new Set(combined.map((e) => e.id)).size).toBe(4);
  expect((await service.reconcile(w.id)).consistent).toBe(true);
});

test("ledger pagination empty wallet returns no entries and no cursor", async () => {
  const w = await wallet("0.00");
  const r = await request(`/wallets/${w.id}/ledger?limit=1`);
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ entries: [], nextCursor: null });
});
