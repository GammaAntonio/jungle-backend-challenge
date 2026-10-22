import { walletEntity } from "../infrastructure/entities";
import { InboxMessage, OutboxMessage } from "../domain/messages";
import { QueryRunner } from "typeorm";
import { atomic, db, type AfterCommit } from "../infrastructure/db";
import {
  Money,
  Wallet,
  WagerTransaction,
  WalletLedgerEntry,
  Direction,
  Kind,
  Status,
} from "../domain/model";
import {
  type WagerIntegrationEvent,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
} from "../domain/events";
import {
  requestSchema,
  openingSchema,
  payloadHash,
  key,
  Request,
  AppError,
} from "./contracts";
import { resolveCorrelationId } from "./correlation";
import { metrics, log, recordRetry, measureProcessing } from "./observability";
interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
}
interface TxRow {
  id: string;
  kind: Kind;
  status: Status;
  request: Request;
  response: Result;
  payload_hash: string;
  idempotency_key: string;
  wallet_id: string;
  reference_id?: string;
  amount: string;
  currency: string;
  player_id: string;
  round_id: string;
  attempts: number;
  created_at: Date;
}
export interface Result {
  transactionId: string;
  status: Status;
  balance: { amount: string; currency: string };
  failureCode?: string;
  idempotentReplay: boolean;
}
const uuid = () => crypto.randomUUID();
const MAX_LEDGER_SEQUENCE = 9_223_372_036_854_775_807n;

/** Decode the opaque cursor shape emitted by previous ledger API versions. */
export function decodeLedgerCursor(cursor: unknown, walletId: string): string {
  try {
    if (
      typeof cursor !== "string" ||
      cursor.length === 0 ||
      cursor.length > 2048 ||
      !/^[A-Za-z0-9_-]+$/.test(cursor)
    )
      throw Error();
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(json).toString("base64url") !== cursor) throw Error();
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw Error();
    const value = parsed as { walletId?: unknown; sequence?: unknown };
    if (
      value.walletId !== walletId ||
      typeof value.sequence !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(value.sequence)
    )
      throw Error();
    if (BigInt(value.sequence) > MAX_LEDGER_SEQUENCE) throw Error();
    return value.sequence;
  } catch {
    throw new AppError("INVALID_CURSOR", 400);
  }
}

function walletFrom(w: WalletRow) {
  return Wallet.rehydrate({
    id: w.id,
    playerId: w.player_id,
    balance: Money.from({ amount: w.balance, currency: w.currency }),
    version: w.version,
  });
}
function walletJSON(w: WalletRow) {
  return {
    id: w.id,
    playerId: w.player_id,
    balance: { amount: w.balance, currency: w.currency },
    version: w.version,
  };
}
async function emit(q: QueryRunner, e: WagerIntegrationEvent) {
  const m = OutboxMessage.enqueue(e);
  const p = m.payload;
  await q.query(
    "INSERT INTO outbox(id,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4)",
    [p.eventId, p.aggregateId, p.eventType, p],
  );
}
export class WageringService {
  async open(raw: unknown) {
    const p = openingSchema.parse(raw);
    const money = Money.from(p.initialBalance);
    const id = uuid();
    try {
      return await atomic(async (q) => {
        const w = Wallet.open({
          id,
          playerId: p.playerId,
          initialBalance: money,
        });
        await q.query(
          "INSERT INTO wallet(id,player_id,currency,balance,version) VALUES($1,$2,$3,$4,1)",
          [id, p.playerId, money.currency, money.toString()],
        );
        if (money.isPositive()) {
          const tid = uuid();
          await q.query(
            "INSERT INTO wager_transaction(id,provider_id,external_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,request,processed_at) VALUES($1::uuid,'__internal__',$1::text,$1::text,'opening',$2,$3,'opening','opening','OPENING',$4,$5,'PROCESSED','{}',now())",
            [tid, id, p.playerId, money.toString(), money.currency],
          );
          await this.ledger(
            q,
            id,
            tid,
            "CREDIT",
            money,
            Money.zero(money.currency),
            money,
          );
          const ctx = {
            aggregateId: id,
            correlationId: resolveCorrelationId(),
          };
          await emit(
            q,
            WalletBalanceChanged.from(ctx, {
              walletId: id,
              transactionId: tid,
              direction: "CREDIT",
              money: money.toJSON(),
              balanceBefore: Money.zero(money.currency).toJSON(),
              balanceAfter: money.toJSON(),
              walletVersion: 1,
            }),
          );
          await emit(
            q,
            WagerTransactionProcessed.from(ctx, {
              transactionId: tid,
              kind: "OPENING",
              balance: money.toJSON(),
            }),
          );
        }
        return {
          id,
          playerId: p.playerId,
          balance: money.toJSON(),
          version: w.version,
        };
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new AppError("WALLET_EXISTS", 409);
      throw e;
    }
  }
  async wallet(id: string) {
    const w = await db.getRepository(walletEntity).findOneBy({ id });
    if (!w) throw new AppError("WALLET_NOT_FOUND", 404);
    return walletJSON(w);
  }
  async transaction(id: string) {
    const [t] = await db.query(
      "SELECT id,provider_id,external_id,kind,status,failure_code,response,created_at,processed_at FROM wager_transaction WHERE id=$1",
      [id],
    );
    if (!t) throw new AppError("TRANSACTION_NOT_FOUND", 404);
    return t;
  }
  async byExternal(provider: string, external: string) {
    const [t] = await db.query(
      "SELECT id FROM wager_transaction WHERE provider_id=$1 AND external_id=$2",
      [provider, external],
    );
    if (!t) throw new AppError("TRANSACTION_NOT_FOUND", 404);
    return this.transaction(t.id);
  }
  async submit(
    raw: unknown,
    idempotencyKey: unknown,
    ctx: { correlationId?: string; messageId?: string } = {},
  ): Promise<Result> {
    ctx = { ...ctx, correlationId: resolveCorrelationId(ctx.correlationId) };
    const p = requestSchema.parse(raw);
    const k = key(idempotencyKey);
    const hash = payloadHash(p);
    const started = performance.now();
    for (let retry = 0; ; retry++) {
      try {
        const result = await atomic(async (q, afterCommit) => {
          if (ctx.messageId)
            await q.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
              ["inbox:wagering-v1:" + ctx.messageId],
            );
          // Wallet row lock serializes balance changes; unique indexes arbitrate identities across wallets.
          const [w]: WalletRow[] = await q.query(
            "SELECT * FROM wallet WHERE id=$1 FOR UPDATE",
            [p.walletId],
          );
          if (!w) throw new AppError("WALLET_NOT_FOUND", 404);
          if (ctx.messageId) {
            const [inbox] = await q.query(
              "SELECT * FROM inbox WHERE consumer_name='wagering-v1' AND message_id=$1",
              [ctx.messageId],
            );
            if (inbox) {
              if (inbox.payload_hash !== hash)
                throw new AppError("INBOX_CONFLICT", 409);
              const [prior] = await q.query(
                "SELECT response FROM wager_transaction WHERE id=$1",
                [inbox.transaction_id],
              );
              afterCommit(() => {
                metrics.duplicates++;
              });
              return { ...prior.response, idempotentReplay: true };
            }
          }
          const matches: TxRow[] = await q.query(
            "SELECT * FROM wager_transaction WHERE provider_id=$1 AND (external_id=$2 OR idempotency_key=$3)",
            [p.providerId, p.externalTransactionId, k],
          );
          if (matches.length) {
            const t = matches[0];
            if (
              matches.length !== 1 ||
              t.payload_hash !== hash ||
              t.idempotency_key !== k
            )
              throw new AppError("IDEMPOTENCY_CONFLICT", 409);
            await this.inbox(q, ctx.messageId, hash, t.id);
            afterCommit(() => {
              metrics.duplicates++;
            });
            return { ...t.response, idempotentReplay: true };
          }
          const id = uuid();
          await q.query(
            "INSERT INTO wager_transaction(id,provider_id,external_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,reference_external_id,status,request) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING',$14)",
            [
              id,
              p.providerId,
              p.externalTransactionId,
              k,
              hash,
              p.walletId,
              p.playerId,
              p.roundId,
              p.gameId,
              p.kind,
              p.money.amount,
              p.money.currency,
              p.referenceExternalTransactionId ?? null,
              p,
            ],
          );
          const result = await this.apply(
            q,
            {
              id,
              kind: p.kind,
              status: "PENDING",
              request: p,
              attempts: 0,
              created_at: new Date(),
            } as TxRow,
            w,
            ctx.correlationId ?? id,
            afterCommit,
            ctx.messageId,
          );
          await this.inbox(q, ctx.messageId, hash, id);
          return result;
        });
        metrics.requests++;
        metrics.latencyMs += performance.now() - started;
        log("transaction", {
          correlationId: ctx.correlationId,
          messageId: ctx.messageId,
          transactionId: result.transactionId,
          walletId: p.walletId,
          providerId: p.providerId,
          status: result.status,
        });
        return result;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (["23505", "40P01", "40001"].includes(code ?? "") && retry < 3) {
          recordRetry("transaction", code);
          await Bun.sleep(10 * (retry + 1) + Math.random() * 20);
          continue;
        }
        throw e;
      }
    }
  }
  private async inbox(
    q: QueryRunner,
    messageId: string | undefined,
    hash: string,
    id: string,
  ) {
    if (messageId) {
      const message = InboxMessage.receive({
        messageId,
        consumerName: "wagering-v1",
        payloadHash: hash,
      });
      message.markProcessed(new Date());
      await q.query(
        "INSERT INTO inbox(consumer_name,message_id,payload_hash,transaction_id) VALUES('wagering-v1',$1,$2,$3) ON CONFLICT DO NOTHING",
        [messageId, hash, id],
      );
    }
  }
  private async ledger(
    q: QueryRunner,
    wid: string,
    tid: string,
    direction: Direction,
    money: Money,
    before: Money,
    after: Money,
  ) {
    WalletLedgerEntry.create({
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
    });
    await q.query(
      "INSERT INTO ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        uuid(),
        wid,
        tid,
        direction,
        money.toString(),
        money.currency,
        before.toString(),
        after.toString(),
      ],
    );
  }
  private async apply(
    q: QueryRunner,
    t: TxRow,
    w: WalletRow,
    correlationId: string,
    afterCommit: AfterCommit,
    causationId?: string,
  ): Promise<Result> {
    const p = t.request;
    const wallet = walletFrom(w);
    const before = wallet.balance;
    const money = Money.from(p.money);
    const tx = WagerTransaction.rehydrate({
      id: t.id,
      kind: t.kind,
      status: t.status,
    });
    let waiting = false;
    let code: string | undefined;
    let reference: TxRow | undefined;
    let direction: Direction | undefined;
    if (w.player_id !== p.playerId) code = "PLAYER_MISMATCH";
    else if (w.currency !== p.money.currency) code = "CURRENCY_MISMATCH";
    if (!code && p.referenceExternalTransactionId) {
      [reference] = await q.query(
        "SELECT * FROM wager_transaction WHERE provider_id=$1 AND external_id=$2",
        [p.providerId, p.referenceExternalTransactionId],
      );
      if (
        !reference ||
        ["PENDING", "PENDING_REFERENCE"].includes(reference.status)
      ) {
        if (
          t.attempts >= 12 ||
          Date.now() - new Date(t.created_at).getTime() >= 86400000
        )
          code = "REFERENCE_TIMEOUT";
        else {
          tx.markPendingReference();
          waiting = true;
        }
      } else if (reference.status !== "PROCESSED")
        code = "REFERENCE_NOT_PROCESSED";
      else if (
        reference.wallet_id !== p.walletId ||
        reference.player_id !== p.playerId ||
        reference.currency !== p.money.currency ||
        reference.round_id !== p.roundId
      )
        code = "REFERENCE_MISMATCH";
      else if (
        ((p.kind === "REFUND" || p.kind === "WIN") &&
          reference.kind !== "BET") ||
        (p.kind === "ROLLBACK" &&
          !["BET", "WIN", "REFUND"].includes(reference.kind))
      )
        code = "REFERENCE_KIND_INVALID";
      else if (
        ["REFUND", "ROLLBACK"].includes(p.kind) &&
        reference.amount !== p.money.amount
      )
        code = "REFERENCE_AMOUNT_MISMATCH";
      else if (["REFUND", "ROLLBACK"].includes(p.kind)) {
        const [previous] = await q.query(
          "SELECT id FROM wager_transaction WHERE reference_id=$1 AND kind=$2 AND status='PROCESSED'",
          [reference.id, p.kind],
        );
        if (previous) code = "ALREADY_REVERSED";
      }
    }
    if (!code && !waiting) {
      direction = tx.ledgerDirectionFor(
        reference
          ? WagerTransaction.rehydrate({
              id: reference.id,
              kind: reference.kind,
              status: reference.status,
            })
          : undefined,
      );
      if (direction === "DEBIT" && before.isLessThan(money))
        code =
          p.kind === "BET"
            ? "INSUFFICIENT_FUNDS"
            : "REVERSAL_INSUFFICIENT_FUNDS";
      else if (direction === "CREDIT" && !before.canAdd(money))
        code = "BALANCE_LIMIT_EXCEEDED";
      else {
        if (direction === "DEBIT") wallet.debit(money);
        if (direction === "CREDIT") wallet.credit(money);
        tx.markProcessed(reference?.id);
        if (direction) {
          await this.ledger(
            q,
            w.id,
            t.id,
            direction,
            money,
            before,
            wallet.balance,
          );
          await q.query(
            "UPDATE wallet SET balance=$2,version=$3,updated_at=now() WHERE id=$1",
            [w.id, wallet.balance.toString(), wallet.version],
          );
        }
      }
    }
    if (code) tx.reject(code);
    const result: Result = {
      transactionId: t.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      ...(code ? { failureCode: code } : {}),
      idempotentReplay: false,
    };
    await q.query(
      "UPDATE wager_transaction SET status=$2,failure_code=$3,reference_id=$4,response=$5,attempts=attempts+1,next_attempt_at=now()+($6 * interval '1 second'),processed_at=CASE WHEN $2 IN ('PROCESSED','REJECTED') THEN now() ELSE NULL END WHERE id=$1",
      [
        t.id,
        tx.status,
        code ?? null,
        reference?.id ?? null,
        result,
        Math.min(3600, 2 ** (t.attempts + 1)),
      ],
    );
    const context = { aggregateId: w.id, correlationId, causationId };
    const data = {
      transactionId: t.id,
      kind: p.kind,
      balance: wallet.balance.toJSON(),
    };
    if (tx.status === "PROCESSED") {
      afterCommit(() => {
        metrics.processed++;
      });
      await emit(
        q,
        WagerTransactionProcessed.from(context, {
          ...data,
          status: "PROCESSED",
        }),
      );
    }
    if (tx.status === "REJECTED") {
      afterCommit(() => {
        metrics.rejected++;
      });
      const failureCode = tx.failureCode;
      if (!failureCode) throw Error("REJECTED_EVENT_REQUIRES_FAILURE_CODE");
      await emit(
        q,
        WagerTransactionRejected.from(context, {
          ...data,
          status: "REJECTED",
          failureCode,
        }),
      );
    }
    if (tx.status === "PENDING_REFERENCE" && t.status !== "PENDING_REFERENCE") {
      afterCommit(() => {
        metrics.pending++;
      });
      await emit(
        q,
        WagerTransactionPendingReference.from(context, {
          ...data,
          status: "PENDING_REFERENCE",
        }),
      );
    }
    if (tx.status === "PROCESSED" && direction)
      await emit(
        q,
        WalletBalanceChanged.from(context, {
          walletId: w.id,
          transactionId: t.id,
          direction,
          money: money.toJSON(),
          balanceBefore: before.toJSON(),
          balanceAfter: wallet.balance.toJSON(),
          walletVersion: wallet.version,
        }),
      );
    return result;
  }
  async retryReferences() {
    const due: TxRow[] = await db.query(
      "SELECT * FROM wager_transaction WHERE status='PENDING_REFERENCE' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 50",
    );
    for (const candidate of due)
      await measureProcessing("reference", () =>
        atomic(async (q, afterCommit) => {
          const [w]: WalletRow[] = await q.query(
            "SELECT * FROM wallet WHERE id=$1 FOR UPDATE",
            [candidate.wallet_id],
          );
          const [t]: TxRow[] = await q.query(
            "SELECT * FROM wager_transaction WHERE id=$1 AND status='PENDING_REFERENCE' AND next_attempt_at<=now() FOR UPDATE",
            [candidate.id],
          );
          if (t) await this.apply(q, t, w, t.id, afterCommit);
        }),
      );
  }
  async reconcile(id: string) {
    return atomic(async (q) => {
      const [w]: WalletRow[] = await q.query(
        "SELECT * FROM wallet WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (!w) throw new AppError("WALLET_NOT_FOUND", 404);
      const [r] = await q.query(
        "SELECT COALESCE(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0)::numeric(18,2)::text AS amount,count(*)::integer AS count FROM ledger WHERE wallet_id=$1",
        [id],
      );
      const stored = Money.from({ amount: w.balance, currency: w.currency });
      const calculated = Money.from({ amount: r.amount, currency: w.currency });
      const consistent = stored.equals(calculated);
      if (!consistent) {
        metrics.divergences++;
        log("reconciliation_divergence", { walletId: id });
      }
      return {
        walletId: id,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: stored.subtract(calculated).toJSON(),
        consistent,
        checkedEntries: r.count,
      };
    });
  }
  async ledgerPage(id: string, cursor?: unknown, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError("INVALID_LIMIT", 400);
    await this.wallet(id);
    const sequence =
      cursor === undefined ? "0" : decodeLedgerCursor(cursor, id);
    const rows = await db.query(
      "SELECT sequence::text,id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at FROM ledger WHERE wallet_id=$1 AND sequence>$2::bigint ORDER BY ledger.sequence LIMIT $3",
      [id, sequence, limit + 1],
    );
    const more = rows.length > limit;
    const entries = rows.slice(0, limit);
    return {
      entries,
      nextCursor: more
        ? Buffer.from(
            JSON.stringify({ walletId: id, sequence: entries.at(-1).sequence }),
          ).toString("base64url")
        : null,
    };
  }
}
