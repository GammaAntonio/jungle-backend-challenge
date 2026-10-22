import type { Client } from "pg";
export const localAdminUrl =
  "postgres://jungle:jungle_dev@127.0.0.1:5432/jungle";
export const localRuntimeUrl =
  "postgres://jungle_runtime:jungle_runtime_dev@127.0.0.1:5432/jungle";
export function assertRuntimeDatabaseConfiguration() {
  const runtime = new URL(process.env.DATABASE_URL ?? localRuntimeUrl);
  const runtimeUser = decodeURIComponent(runtime.username);
  const admin = process.env.ADMIN_DATABASE_URL;
  const adminUser = admin
    ? decodeURIComponent(new URL(admin).username)
    : undefined;
  const localAdminUser = decodeURIComponent(new URL(localAdminUrl).username);
  if (
    !runtimeUser ||
    runtimeUser === adminUser ||
    runtimeUser === localAdminUser
  )
    throw Error("UNSAFE_RUNTIME_DATABASE_ROLE");
}

function identifier(value: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value))
    throw Error("INVALID_DATABASE_IDENTIFIER");
  return '"' + value + '"';
}
export async function provisionRuntimeRole(
  admin: Client,
  role: string,
  password: string,
) {
  const name = identifier(role);
  await admin.query("SELECT pg_advisory_lock(981238)");
  try {
    const found = await admin.query(
      "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1",
      [role],
    );
    if (found.rows.length) {
      if (Object.values(found.rows[0]).some(Boolean))
        throw Error("RUNTIME_ROLE_IS_PRIVILEGED");
      const memberships = await admin.query(
        "SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)",
        [role],
      );
      if (memberships.rowCount) throw Error("RUNTIME_ROLE_HAS_MEMBERSHIPS");
    } else
      await admin.query(
        `CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    const literal = await admin.query(
      "SELECT quote_literal($1::text) AS value",
      [password],
    );
    await admin.query(
      `ALTER ROLE ${name} LOGIN NOINHERIT PASSWORD ${literal.rows[0].value}`,
    );
  } finally {
    await admin.query("SELECT pg_advisory_unlock(981238)");
  }
}
export async function grantRuntimePrivileges(
  admin: Client,
  schema: string,
  role: string,
) {
  const namespace = identifier(schema),
    name = identifier(role);
  await admin.query(`GRANT USAGE ON SCHEMA ${namespace} TO ${name}`);
  await admin.query(`REVOKE CREATE ON SCHEMA ${namespace} FROM ${name}`);
  const tables = ["wallet", "wager_transaction", "ledger", "inbox", "outbox"];
  for (const table of tables) {
    await admin.query(`REVOKE ALL ON TABLE ${namespace}.${table} FROM ${name}`);
    const columns = await admin.query(
      "SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped",
      [`${namespace}.${table}`],
    );
    const names = columns.rows.map((row) => identifier(row.attname)).join(",");
    await admin.query(
      `REVOKE SELECT(${names}),INSERT(${names}),UPDATE(${names}),REFERENCES(${names}) ON TABLE ${namespace}.${table} FROM ${name}`,
    );
  }
  await admin.query(
    `GRANT SELECT,INSERT ON ${tables.map((t) => namespace + "." + t).join(",")} TO ${name}`,
  );
  await admin.query(
    `GRANT UPDATE(balance,version,updated_at) ON ${namespace}.wallet TO ${name}`,
  );
  await admin.query(
    `GRANT UPDATE(status,failure_code,reference_id,response,attempts,next_attempt_at,processed_at) ON ${namespace}.wager_transaction TO ${name}`,
  );
  await admin.query(
    `GRANT UPDATE(attempts,next_attempt_at,claim_token,claimed_until,published_at) ON ${namespace}.outbox TO ${name}`,
  );
  await admin.query(
    `GRANT USAGE ON SEQUENCE ${namespace}.ledger_sequence_seq TO ${name}`,
  );
}
