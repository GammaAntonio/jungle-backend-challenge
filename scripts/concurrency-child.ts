import { connect, db } from "../src/infrastructure/db";
import { WageringService } from "../src/application/wagering";
await connect();
const s = new WageringService();
const tasks = JSON.parse(process.env.TASKS ?? "[]");
await Bun.write(Bun.stdout, "READY\n");
for await (const chunk of Bun.stdin.stream()) {
  if (new TextDecoder().decode(chunk).includes("GO")) break;
}
const results = await Promise.all(
  tasks.map((t: { body: unknown; key: string }) => s.submit(t.body, t.key)),
);
console.log(JSON.stringify(results));
await db.destroy();
