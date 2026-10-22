import { walletEntity } from "./entities";
import "reflect-metadata";
import { DataSource, QueryRunner } from "typeorm";
import { localRuntimeUrl } from "./permissions";
export const db = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL ?? localRuntimeUrl,
  entities: [walletEntity],
  synchronize: false,
  extra: {
    max: 20,
    connectionTimeoutMillis: 5000,
    options: process.env.DB_SCHEMA
      ? `-c search_path=${process.env.DB_SCHEMA}`
      : undefined,
  },
});
export async function connect() {
  if (!db.isInitialized) await db.initialize();
  return db;
}
export async function connectRuntime() {
  await connect();
  const [role] = await db.query(
    "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,has_schema_privilege(current_schema(),'CREATE') AS can_create,has_table_privilege('ledger','TRUNCATE,DELETE') AS can_destroy_ledger,has_any_column_privilege('ledger','UPDATE') AS can_update_ledger FROM pg_roles WHERE rolname=current_user",
  );
  if (Object.values(role).some(Boolean)) {
    await db.destroy();
    throw Error("UNSAFE_RUNTIME_DATABASE_ROLE");
  }
}
export type AfterCommit = (effect: () => void) => void;
export async function atomic<T>(
  fn: (q: QueryRunner, afterCommit: AfterCommit) => Promise<T>,
): Promise<T> {
  const q = db.createQueryRunner();
  await q.connect();
  await q.startTransaction();
  const effects: (() => void)[] = [];
  let result: T;
  try {
    result = await fn(q, (effect) => effects.push(effect));
    await q.commitTransaction();
  } catch (e) {
    await q.rollbackTransaction().catch(() => {});
    throw e;
  } finally {
    await q.release();
  }
  for (const effect of effects) effect();
  return result;
}
export async function migrate(direction = "up") {
  await connect();
  await atomic(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock(981237)");
    await q.query(
      "CREATE TABLE IF NOT EXISTS schema_migration(version text PRIMARY KEY)",
    );
    const versions =
      direction === "down" ? ["003", "002", "001"] : ["001", "002", "003"];
    for (const version of versions) {
      const applied = await q.query(
        "SELECT * FROM schema_migration WHERE version=$1",
        [version],
      );
      if (direction === "up" && !applied.length) {
        await q.query(await Bun.file(`migrations/${version}.up.sql`).text());
        await q.query("INSERT INTO schema_migration VALUES ($1)", [version]);
      } else if (direction === "down" && applied.length) {
        await q.query(await Bun.file(`migrations/${version}.down.sql`).text());
        await q.query("DELETE FROM schema_migration WHERE version=$1", [
          version,
        ]);
      }
    }
  });
}
