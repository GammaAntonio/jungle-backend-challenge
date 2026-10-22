import { localAdminUrl } from "../src/infrastructure/permissions";
process.env.DATABASE_URL = process.env.ADMIN_DATABASE_URL ?? localAdminUrl;
const { migrate, db } = await import("../src/infrastructure/db");
try {
  await migrate(process.argv[2]);
} finally {
  if (db.isInitialized) await db.destroy();
}
