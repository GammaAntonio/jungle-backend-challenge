import { connect, db } from "../src/infrastructure/db";
import { WageringService } from "../src/application/wagering";
import { consumeOnce } from "../src/infrastructure/consumer";
import { publishBatch } from "../src/infrastructure/outbox";
await connect();
const checkpoint = async () => {
  console.log("READY_FOR_KILL");
  await new Promise<void>(() => {});
};
const mode = process.argv[2];
if (mode === "consume")
  await consumeOnce(new WageringService(), () => false, checkpoint);
if (mode === "publish-crash") await publishBatch(checkpoint);
if (mode === "publish") await publishBatch();
if (mode === "reconcile")
  console.log(
    JSON.stringify(
      await new WageringService().reconcile(process.env.WALLET_ID!),
    ),
  );
await db.destroy();
