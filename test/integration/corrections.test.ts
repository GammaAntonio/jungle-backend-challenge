import { beforeAll, afterAll, test, expect } from "bun:test";
import { Client } from "pg";
import {
  setup,
  cleanup,
  schema,
  runtimeUrl,
  runtimeRole,
  adminUrl,
  wallet,
  bet,
  service,
} from "../support";
import { db, migrate } from "../../src/infrastructure/db";
import { metrics } from "../../src/application/observability";
import { grantRuntimePrivileges } from "../../src/infrastructure/permissions";
beforeAll(setup);
afterAll(cleanup);

test("A01 runtime role has minimum DML rights and cannot truncate, mutate ledger or administer schema", async () => {
  const w = await wallet();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `GRANT UPDATE(amount) ON "${schema}".ledger TO "${runtimeRole}"`,
    );
    await grantRuntimePrivileges(admin, schema, runtimeRole);
    await grantRuntimePrivileges(admin, schema, runtimeRole);
  } finally {
    await admin.end();
  }
  const c = new Client({
    connectionString: runtimeUrl,
    options: `-c search_path=${schema}`,
  });
  await c.connect();
  try {
    const [role] = (
      await c.query(
        "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,has_schema_privilege(current_schema(),'CREATE') AS ddl,has_table_privilege('ledger','TRUNCATE') AS truncate,has_table_privilege('ledger','UPDATE') AS update,has_table_privilege('ledger','DELETE') AS delete FROM pg_roles WHERE rolname=current_user",
      )
    ).rows;
    expect(Object.values(role).every((x) => x === false)).toBe(true);
    for (const sql of [
      "TRUNCATE ledger",
      "UPDATE ledger SET amount=amount",
      "DELETE FROM ledger",
      "ALTER TABLE ledger DISABLE TRIGGER ALL",
      "CREATE TABLE forbidden(id int)",
      "DROP TABLE ledger",
      `SET ROLE "${decodeURIComponent(new URL(adminUrl).username)}"`,
    ]) {
      let code = "";
      try {
        await c.query(sql);
      } catch (e) {
        code = (e as { code: string }).code;
      }
      expect(code).toBe("42501");
    }
    expect(
      (
        await c.query(
          "SELECT count(*)::int AS n FROM ledger WHERE wallet_id=$1",
          [w.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect((await service.reconcile(w.id)).consistent).toBe(true);
  } finally {
    await c.end();
  }
});

test("A01 migration 002 upgrades existing ledger without rewriting migration 001 or removing history", async () => {
  const w = await wallet();
  await db.query(await Bun.file("migrations/002.down.sql").text());
  await db.query("DELETE FROM schema_migration WHERE version='002'");
  await migrate();
  await migrate();
  expect((await service.reconcile(w.id)).storedBalance.amount).toBe("100.00");
  expect((await service.reconcile(w.id)).checkedEntries).toBe(1);
  await expect(db.query("TRUNCATE ledger")).rejects.toThrow("immutable");
  expect(
    (
      await db.query("SELECT version FROM schema_migration ORDER BY version")
    ).map((r: { version: string }) => r.version),
  ).toEqual(["001", "002", "003"]);
});

for (const status of ["PROCESSED", "REJECTED", "PENDING_REFERENCE"] as const)
  test(`A02 ${status} metric changes only after confirmed commit and never on replay`, async () => {
    const w = await wallet();
    const body =
      status === "REJECTED"
        ? bet(w, "180.00")
        : status === "PENDING_REFERENCE"
          ? bet(w, "25.00", {
              kind: "REFUND",
              referenceExternalTransactionId: "missing",
            })
          : bet(w);
    const key = "commit-" + w.id;
    const counters = () => ({
      processed: metrics.processed,
      rejected: metrics.rejected,
      pending: metrics.pending,
      duplicates: metrics.duplicates,
      requests: metrics.requests,
    });
    const before = counters();
    await db.query(
      "CREATE FUNCTION regression_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'regression commit failure'; END $$",
    );
    await db.query(
      "CREATE CONSTRAINT TRIGGER regression_commit_failure AFTER INSERT ON inbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION regression_commit_failure()",
    );
    try {
      await expect(
        service.submit(body, key, { messageId: key }),
      ).rejects.toThrow("regression commit failure");
      expect(counters()).toEqual(before);
      expect((await service.reconcile(w.id)).storedBalance.amount).toBe(
        "100.00",
      );
    } finally {
      await db.query("DROP TRIGGER regression_commit_failure ON inbox");
      await db.query("DROP FUNCTION regression_commit_failure()");
    }
    const result = await service.submit(body, key, { messageId: key });
    expect(result.status).toBe(status);
    const field =
      status === "PROCESSED"
        ? "processed"
        : status === "REJECTED"
          ? "rejected"
          : "pending";
    expect(metrics[field]).toBe(before[field] + 1);
    const committed = counters();
    expect(
      (await service.submit(body, key, { messageId: key })).idempotentReplay,
    ).toBe(true);
    expect(metrics[field]).toBe(committed[field]);
    expect(metrics.duplicates).toBe(committed.duplicates + 1);
  });

test("A02 pending-reference worker counts terminal rejection only after its commit", async () => {
  const w = await wallet();
  const pending = await service.submit(
    bet(w, "25.00", {
      kind: "REFUND",
      referenceExternalTransactionId: "worker-missing",
    }),
    "worker-" + w.id,
  );
  await db.query(
    "UPDATE wager_transaction SET attempts=12,next_attempt_at=now() WHERE id=$1",
    [pending.transactionId],
  );
  const before = metrics.rejected;
  await db.query(
    "CREATE FUNCTION regression_worker_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'worker commit failure'; END $$",
  );
  await db.query(
    "CREATE CONSTRAINT TRIGGER regression_worker_failure AFTER INSERT ON outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION regression_worker_failure()",
  );
  try {
    await expect(service.retryReferences()).rejects.toThrow(
      "worker commit failure",
    );
    expect(metrics.rejected).toBe(before);
    expect((await service.transaction(pending.transactionId)).status).toBe(
      "PENDING_REFERENCE",
    );
  } finally {
    await db.query("DROP TRIGGER regression_worker_failure ON outbox");
    await db.query("DROP FUNCTION regression_worker_failure()");
  }
  await service.retryReferences();
  expect(metrics.rejected).toBe(before + 1);
  expect((await service.transaction(pending.transactionId)).status).toBe(
    "REJECTED",
  );
});

test("A01 HTTP runtime refuses administrative database credentials", async () => {
  const child = Bun.spawn([process.execPath, "src/main.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: adminUrl,
      DB_SCHEMA: schema,
      PORT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).not.toBe(0);
  expect(stderr).toContain("UNSAFE_RUNTIME_DATABASE_ROLE");
});

test("A03 HTTP correlation is generated or validated and propagated to logs and outbox", async () => {
  const child = Bun.spawn([process.execPath, "src/main.ts"], {
    env: { ...process.env, PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let lines = "";
  let port = 0;
  const pump = (async () => {
    for (;;) {
      const x = await reader.read();
      if (x.done) break;
      lines += new TextDecoder().decode(x.value);
      const line = lines.split("\n").find((l) => l.includes("http_listening"));
      if (line) port = JSON.parse(line).port;
    }
  })();
  try {
    const deadline = Date.now() + 10000;
    while (!port) {
      if (Date.now() > deadline) throw Error("HTTP child not ready: " + lines);
      await Bun.sleep(10);
    }
    const base = "http://127.0.0.1:" + port;
    const send = async (
      path: string,
      body: unknown,
      header?: string,
      key?: string,
    ) => {
      const r = await fetch(base + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(header !== undefined ? { "x-correlation-id": header } : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: JSON.stringify(body),
      });
      return {
        status: r.status,
        id: r.headers.get("x-correlation-id")!,
        body: (await r.json()) as {
          id: string;
          playerId: string;
          transactionId: string;
        },
      };
    };
    const opened = await send("/wallets", {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    expect(opened.status).toBe(201);
    expect(opened.id).toMatch(/^[a-f0-9-]{36}$/);
    const cases = await Promise.all([
      send(
        "/wagering/transactions",
        bet(opened.body),
        undefined,
        crypto.randomUUID(),
      ),
      send(
        "/wagering/transactions",
        bet(opened.body),
        "provider:trace-42",
        crypto.randomUUID(),
      ),
      send(
        "/wagering/transactions",
        bet(opened.body),
        "invalid value",
        crypto.randomUUID(),
      ),
    ]);
    expect(cases[0].id).toMatch(/^[a-f0-9-]{36}$/);
    expect(cases[1].id).toBe("provider:trace-42");
    expect(cases[2].id).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Set(cases.map((r) => r.id)).size).toBe(3);
    for (const r of cases) {
      expect(r.status).toBe(200);
      const events = await db.query(
        "SELECT payload->>'correlationId' AS correlation FROM outbox WHERE payload->'data'->>'transactionId'=$1",
        [r.body.transactionId],
      );
      expect(events.length).toBe(2);
      expect(
        events.every((e: { correlation: string }) => e.correlation === r.id),
      ).toBe(true);
    }
    const openingEvents = await db.query(
      "SELECT payload->>'correlationId' AS correlation FROM outbox WHERE aggregate_id=$1 AND payload->'data'->>'kind'='OPENING'",
      [opened.body.id],
    );
    expect(openingEvents[0].correlation).toBe(opened.id);
    const invalid = await send("/wagering/transactions", {});
    expect(invalid.status).toBe(400);
    expect(invalid.id).toMatch(/^[a-f0-9-]{36}$/);
    const logDeadline = Date.now() + 5000;
    while (
      lines
        .split("\n")
        .filter((line) => line.includes('"event":"http_request"')).length < 5
    ) {
      if (Date.now() > logDeadline) throw Error("HTTP completion logs missing");
      await Bun.sleep(10);
    }
  } finally {
    child.kill();
    await child.exited;
    await pump;
  }
  const logs = lines
    .split("\n")
    .filter((x) => x.startsWith("{"))
    .map((x) => JSON.parse(x));
  const transactionLogs = logs.filter((x) => x.event === "transaction");
  expect(transactionLogs.length).toBe(3);
  expect(
    transactionLogs.every(
      (x) => typeof x.correlationId === "string" && x.correlationId.length > 0,
    ),
  ).toBe(true);
  expect(logs.filter((x) => x.event === "http_request").length).toBe(5);
  for (const entry of transactionLogs) {
    const request = logs.find(
      (x) =>
        x.event === "http_request" && x.correlationId === entry.correlationId,
    );
    expect(request.status).toBe(200);
  }
});
