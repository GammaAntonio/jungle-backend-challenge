import { atomic, db } from "./db";
import { sendIntegrationEvent } from "./sqs";
import { OutboxMessage } from "../domain/messages";
import {
  recordRetry,
  recordProcessing,
  log,
} from "../application/observability";
interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}
export async function publishBatch(afterSend?: (id: string) => Promise<void>) {
  const token = crypto.randomUUID();
  const rows: OutboxRow[] = await atomic((q) =>
    q.query(
      "WITH due AS (SELECT id FROM outbox WHERE published_at IS NULL AND next_attempt_at<=now() AND (claimed_until IS NULL OR claimed_until<now()) ORDER BY occurred_at FOR UPDATE SKIP LOCKED LIMIT 20), claimed AS (UPDATE outbox o SET claim_token=$1,claimed_until=now()+interval '60 seconds' FROM due WHERE o.id=due.id RETURNING o.*) SELECT * FROM claimed",
      [token],
    ),
  );
  for (const row of rows) {
    const started = performance.now();
    try {
      const message = OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: row.occurred_at,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        publishedAt: row.published_at ?? undefined,
      });
      await sendIntegrationEvent(message.payload);
      if (afterSend) await afterSend(row.id);
      await db.query(
        "UPDATE outbox SET published_at=now(),claimed_until=NULL WHERE id=$1 AND claim_token=$2",
        [row.id, token],
      );
    } catch {
      recordRetry("outbox");
      await db.query(
        "UPDATE outbox SET attempts=attempts+1,next_attempt_at=now()+(LEAST(3600,power(2,LEAST(attempts+1,12))) * interval '1 second'),claimed_until=NULL WHERE id=$1 AND claim_token=$2",
        [row.id, token],
      );
      log("outbox_retry", { eventId: row.id });
    } finally {
      recordProcessing("outbox", performance.now() - started);
    }
  }
  return rows.length;
}
