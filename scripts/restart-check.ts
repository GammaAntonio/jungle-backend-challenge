import { mkdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { Client } from "pg";

const mode = process.argv[2];
const project = process.env.HOMOLOGATION_PROJECT ?? "";
const suffix = project.replace(/^jungle-homologation-/, "");
const expectedDatabase = `jungle_homologation_${suffix}`;
const adminUrl = process.env.ADMIN_DATABASE_URL ?? "";
const runtimeUrl = process.env.DATABASE_URL ?? "";
const evidenceRoot = resolve("docs/audit/homologation");
const evidencePath = resolve(
  process.argv[3] ?? `${evidenceRoot}/restart-${suffix}.json`,
);

if (!/^jungle-homologation-[a-z0-9]{6,12}$/.test(project))
  throw Error("RESTART_CHECK_REQUIRES_ISOLATED_HOMOLOGATION_PROJECT");
if (!evidencePath.startsWith(evidenceRoot + sep))
  throw Error("RESTART_FIXTURE_MUST_STAY_IN_HOMOLOGATION_EVIDENCE");
if (mode !== "prepare" && mode !== "verify")
  throw Error("Use prepare or verify in the isolated homologation project");

function assertIsolatedUrls() {
  if (!adminUrl || !runtimeUrl) throw Error("ADMIN_AND_RUNTIME_URLS_REQUIRED");
  const admin = new URL(adminUrl);
  const runtime = new URL(runtimeUrl);
  const host = (url: URL) =>
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (
    !host(admin) ||
    !host(runtime) ||
    admin.host !== runtime.host ||
    admin.pathname !== `/${expectedDatabase}` ||
    runtime.pathname !== `/${expectedDatabase}` ||
    decodeURIComponent(admin.username) ===
      decodeURIComponent(runtime.username) ||
    decodeURIComponent(admin.username) !== "homologation_admin" ||
    decodeURIComponent(runtime.username) !== "jungle_runtime"
  )
    throw Error("RESTART_CHECK_DATABASE_NOT_ISOLATED_OR_ROLES_NOT_SEPARATE");
}

assertIsolatedUrls();
mkdirSync(dirname(evidencePath), { recursive: true });
const schema = `homologation_restart_${suffix}_${crypto.randomUUID().replaceAll("-", "")}`;

if (mode === "prepare") {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }

  const migration = Bun.spawn(["bun", "scripts/provision-db.ts"], {
    env: {
      ...process.env,
      ADMIN_DATABASE_URL: adminUrl,
      DATABASE_URL: runtimeUrl,
      DB_SCHEMA: schema,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const migrationExit = await migration.exited;
  if (migrationExit !== 0)
    throw Error(`ISOLATED_PROVISION_FAILED_${migrationExit}`);

  process.env.DB_SCHEMA = schema;
  process.env.DATABASE_URL = runtimeUrl;
  const { assertRuntimeDatabaseConfiguration } =
    await import("../src/infrastructure/permissions");
  assertRuntimeDatabaseConfiguration();
  const { connectRuntime, db } = await import("../src/infrastructure/db");
  const { WageringService } = await import("../src/application/wagering");
  try {
    await connectRuntime();
    const service = new WageringService();
    const wallet = await service.open({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const body = {
      providerId: "restart-test",
      externalTransactionId: crypto.randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "restart-round",
      gameId: "restart-game",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    };
    const result = await service.submit(body, "restart-key");
    const fixture = {
      project,
      schema,
      walletId: wallet.id,
      body,
      result,
      preparedAt: new Date().toISOString(),
    };
    await Bun.write(evidencePath, JSON.stringify(fixture, null, 2) + "\n");
    console.log(
      JSON.stringify({ prepared: true, project, schema, walletId: wallet.id }),
    );
  } finally {
    if (db.isInitialized) await db.destroy();
  }
} else {
  const fixture = await Bun.file(evidencePath).json();
  if (
    fixture.project !== project ||
    !new RegExp(`^homologation_restart_${suffix}_[a-f0-9]{32}$`).test(
      fixture.schema,
    )
  )
    throw Error("RESTART_FIXTURE_SCOPE_MISMATCH");

  process.env.DB_SCHEMA = fixture.schema;
  process.env.DATABASE_URL = runtimeUrl;
  const { assertRuntimeDatabaseConfiguration } =
    await import("../src/infrastructure/permissions");
  assertRuntimeDatabaseConfiguration();
  const { connectRuntime, db } = await import("../src/infrastructure/db");
  const { WageringService } = await import("../src/application/wagering");
  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      const probe = new Client({ connectionString: runtimeUrl });
      try {
        await probe.connect();
        await probe.query("SELECT 1");
        await probe.end();
        break;
      } catch (error) {
        await probe.end().catch(() => {});
        if (Date.now() > deadline) throw error;
        await Bun.sleep(250);
      }
    }
    await connectRuntime();
    const service = new WageringService();
    const replay = await service.submit(fixture.body, "restart-key");
    if (
      replay.transactionId !== fixture.result.transactionId ||
      replay.balance.amount !== "75.00" ||
      !replay.idempotentReplay
    )
      throw Error("REPLAY_MISMATCH");
    const report = await service.reconcile(fixture.walletId);
    if (!report.consistent || report.storedBalance.amount !== "75.00")
      throw Error("RECONCILIATION_MISMATCH");
    const ledger = await service.ledgerPage(fixture.walletId);
    if (ledger.entries.length !== 2) throw Error("LEDGER_PERSISTENCE_MISMATCH");
    console.log(
      JSON.stringify({
        restartPersistence: "PASS",
        idempotency: "PASS",
        reconciliation: "PASS",
        ledgerEntries: ledger.entries.length,
        project,
        schema: fixture.schema,
      }),
    );
  } finally {
    if (db.isInitialized) await db.destroy();
  }
}
