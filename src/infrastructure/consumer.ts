import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { sqs, queueNames, queueUrl } from "./sqs";
import { WageringService } from "../application/wagering";
import { key, AppError } from "../application/contracts";
import { ZodError } from "zod";
import {
  log,
  recordRetry,
  recordProcessing,
} from "../application/observability";
export async function consumeOnce(
  service: WageringService,
  stopping: () => boolean = () => false,
  afterCommit?: () => Promise<void>,
) {
  const url = await queueUrl(queueNames.requests);
  const batch = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      WaitTimeSeconds: 10,
      MaxNumberOfMessages: 5,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
  );
  for (const message of batch.Messages ?? []) {
    if (stopping()) {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: url,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
      continue;
    }
    const started = performance.now();
    try {
      const envelope = JSON.parse(message.Body ?? "");
      key(envelope.messageId);
      if (
        envelope.type !== "WagerTransactionRequested" ||
        !Number.isFinite(Date.parse(envelope.occurredAt))
      )
        throw Error("INVALID_ENVELOPE");
      const { idempotencyKey, ...data } = envelope.data;
      await service.submit(data, idempotencyKey, {
        messageId: envelope.messageId,
        correlationId: envelope.messageId,
      });
      if (afterCommit) await afterCommit();
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: url,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } catch (error) {
      recordRetry("sqs");
      const attempt = Number(
        message.Attributes?.ApproximateReceiveCount ?? "1",
      );
      const permanent =
        error instanceof ZodError ||
        (error instanceof AppError && error.httpStatus < 500) ||
        error instanceof SyntaxError ||
        (error instanceof Error && error.message === "INVALID_ENVELOPE");
      log("sqs_retry", {
        messageId: message.MessageId,
        attempt,
        category: permanent ? "PERMANENT_AWAITING_DLQ" : "TRANSIENT",
      });
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: url,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: Math.min(60, 2 ** attempt),
        }),
      );
    } finally {
      recordProcessing("sqs", performance.now() - started);
    }
  }
  return batch.Messages?.length ?? 0;
}
