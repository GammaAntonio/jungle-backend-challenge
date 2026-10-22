import { test, expect, beforeAll, afterAll } from "bun:test";
import { setup, cleanup, wallet, bet, service } from "../support";
import { db } from "../../src/infrastructure/db";
beforeAll(setup);
afterAll(cleanup);
test("conflicting payloads submitted simultaneously cannot share an effect", async () => {
  const w = await wallet();
  const b = bet(w);
  const key = crypto.randomUUID();
  const results = await Promise.allSettled([
    service.submit(b, key),
    service.submit({ ...b, money: { amount: "26.00", currency: "BRL" } }, key),
  ]);
  expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
  const rejected = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  expect(rejected.reason.message).toBe("IDEMPOTENCY_CONFLICT");
  expect((await service.reconcile(w.id)).consistent).toBe(true);
  const [n] = await db.query(
    "SELECT count(*)::int AS n FROM ledger WHERE wallet_id=$1 AND direction='DEBIT'",
    [w.id],
  );
  expect(n.n).toBe(1);
});
async function processes(tasks: { body: unknown; key: string }[][]) {
  const children = tasks.map((group) =>
    Bun.spawn([process.execPath, "scripts/concurrency-child.ts"], {
      env: { ...process.env, TASKS: JSON.stringify(group) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const readers = children.map((c) => c.stdout.getReader());
  const heads = await Promise.all(readers.map((r) => r.read()));
  for (const h of heads)
    expect(new TextDecoder().decode(h.value)).toContain("READY");
  for (const c of children) {
    c.stdin.write("GO\n");
    c.stdin.end();
  }
  const outputs = await Promise.all(
    readers.map(async (r, i) => {
      let text = "";
      for (;;) {
        const x = await r.read();
        if (x.done) break;
        text += new TextDecoder().decode(x.value);
      }
      const exit = await children[i].exited;
      if (exit !== 0)
        throw Error(await new Response(children[i].stderr).text());
      const line = text.split("\n").find((l) => l.startsWith("["));
      if (!line) throw Error(text);
      return JSON.parse(line);
    }),
  );
  return outputs.flat();
}
test("50 parallel duplicates across three independent processes, persisted original replay", async () => {
  const w = await wallet();
  const b = bet(w);
  const groups = [[], [], []] as { body: unknown; key: string }[][];
  for (let i = 0; i < 50; i++)
    groups[i % 3].push({ body: b, key: "duplicate" + w.id });
  const r = await processes(groups);
  expect(new Set(r.map((x) => x.transactionId)).size).toBe(1);
  expect(r.filter((x) => !x.idempotentReplay).length).toBe(1);
  expect((await service.wallet(w.id)).balance.amount).toBe("75.00");
  expect((await service.reconcile(w.id)).consistent).toBe(true);
  const [n] = await db.query(
    "SELECT count(*)::int AS n FROM ledger WHERE wallet_id=$1 AND direction='DEBIT'",
    [w.id],
  );
  expect(n.n).toBe(1);
  await expect(
    service.submit(
      { ...b, money: { amount: "26.00", currency: "BRL" } },
      "duplicate" + w.id,
    ),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});
test("two 80 bets compete over 100; third process operates another wallet", async () => {
  const w = await wallet();
  const other = await wallet();
  const r = await processes([
    [{ body: bet(w, "80.00"), key: crypto.randomUUID() }],
    [{ body: bet(w, "80.00"), key: crypto.randomUUID() }],
    [{ body: bet(other, "80.00"), key: crypto.randomUUID() }],
  ]);
  expect(r.filter((x) => x.status === "PROCESSED").length).toBe(2);
  expect(r.filter((x) => x.failureCode === "INSUFFICIENT_FUNDS").length).toBe(
    1,
  );
  expect((await service.wallet(w.id)).balance.amount).toBe("20.00");
  expect((await service.reconcile(w.id)).consistent).toBe(true);
  expect((await service.reconcile(other.id)).consistent).toBe(true);
});
