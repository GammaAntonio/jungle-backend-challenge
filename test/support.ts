import {
  configureQueuePrefix,
  queueNames,
  queueUrl,
  sqs,
} from "../src/infrastructure/sqs";
import { DeleteQueueCommand } from "@aws-sdk/client-sqs";
import { Client } from "pg";
import {
  localAdminUrl,
  provisionRuntimeRole,
  grantRuntimePrivileges,
} from "../src/infrastructure/permissions";
import { db, migrate } from "../src/infrastructure/db";
import { WageringService } from "../src/application/wagering";
export const service = new WageringService();
export const schema = "test_" + crypto.randomUUID().replaceAll("-", "");
export const runtimeRole = schema + "_rt";
export const adminUrl =
  process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL ?? localAdminUrl;
const runtimeConnection = new URL(adminUrl);
runtimeConnection.username = runtimeRole;
runtimeConnection.password = crypto.randomUUID();
export const runtimeUrl = runtimeConnection.toString();
export async function setup() {
  configureQueuePrefix(schema + "-");
  process.env.SQS_QUEUE_PREFIX = schema + "-";
  const admin = new Client({
    connectionString: adminUrl,
  });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);

  process.env.DB_SCHEMA = schema;
  db.setOptions({
    url: adminUrl,
    extra: { max: 30, options: `-c search_path=${schema}` },
  });
  await migrate();
  await provisionRuntimeRole(
    admin,
    runtimeRole,
    decodeURIComponent(runtimeConnection.password),
  );
  await grantRuntimePrivileges(admin, schema, runtimeRole);
  await admin.end();
  process.env.ADMIN_DATABASE_URL = adminUrl;
  process.env.DATABASE_URL = runtimeUrl;
}
export async function cleanup() {
  for (const name of Object.values(queueNames)) {
    try {
      await sqs.send(
        new DeleteQueueCommand({ QueueUrl: await queueUrl(name) }),
      );
    } catch {}
  }
  if (db.isInitialized) {
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.query(`DROP ROLE "${runtimeRole}"`);
    await db.destroy();
  }
}
export async function wallet(amount = "100.00") {
  return service.open({
    playerId: crypto.randomUUID(),
    initialBalance: { amount, currency: "BRL" },
  });
}
export function bet(
  w: { id: string; playerId: string },
  amount = "25.00",
  extra: Record<string, unknown> = {},
) {
  return {
    providerId: "provider-a",
    externalTransactionId: crypto.randomUUID(),
    walletId: w.id,
    playerId: w.playerId,
    roundId: "round-a",
    gameId: "game-a",
    kind: "BET",
    money: { amount, currency: "BRL" },
    ...extra,
  };
}
