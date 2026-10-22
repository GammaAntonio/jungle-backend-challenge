import { Client } from "pg";
import {
  localAdminUrl,
  localRuntimeUrl,
  provisionRuntimeRole,
  grantRuntimePrivileges,
} from "../src/infrastructure/permissions";
const adminUrl = process.env.ADMIN_DATABASE_URL ?? localAdminUrl;
const runtimeUrl = new URL(process.env.DATABASE_URL ?? localRuntimeUrl);
if (runtimeUrl.username === new URL(adminUrl).username)
  throw Error("ADMIN_AND_RUNTIME_MUST_DIFFER");
process.env.DATABASE_URL = adminUrl;
const { migrate, db } = await import("../src/infrastructure/db");
const admin = new Client({ connectionString: adminUrl });
await admin.connect();
try {
  await provisionRuntimeRole(
    admin,
    decodeURIComponent(runtimeUrl.username),
    decodeURIComponent(runtimeUrl.password),
  );
  await migrate();
  await grantRuntimePrivileges(
    admin,
    process.env.DB_SCHEMA ?? "public",
    decodeURIComponent(runtimeUrl.username),
  );
  console.log(
    "Runtime role provisioned; migrations applied; least privileges granted",
  );
} finally {
  await admin.end();
  if (db.isInitialized) await db.destroy();
}
