import { z } from "zod";
import { Money, type MoneyProps, type Kind, type Direction } from "./model";

export interface EventContext {
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
}
export interface WagerTransactionProcessedData {
  readonly transactionId: string;
  readonly kind: Kind;
  readonly balance: Readonly<MoneyProps>;
  // Version 1 OPENING events have always omitted status.
  readonly status?: "PROCESSED";
}
export interface WagerTransactionRejectedData {
  readonly transactionId: string;
  readonly kind: Kind;
  readonly balance: Readonly<MoneyProps>;
  readonly status: "REJECTED";
  readonly failureCode: string;
}
export interface WagerTransactionPendingReferenceData {
  readonly transactionId: string;
  readonly kind: Kind;
  readonly balance: Readonly<MoneyProps>;
  readonly status: "PENDING_REFERENCE";
}
export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: Direction;
  readonly money: Readonly<MoneyProps>;
  readonly balanceBefore: Readonly<MoneyProps>;
  readonly balanceAfter: Readonly<MoneyProps>;
  readonly walletVersion: number;
}
export interface EventDataMap {
  WagerTransactionProcessed: WagerTransactionProcessedData;
  WagerTransactionRejected: WagerTransactionRejectedData;
  WagerTransactionPendingReference: WagerTransactionPendingReferenceData;
  WalletBalanceChanged: WalletBalanceChangedData;
}
export type EventType = keyof EventDataMap;
export interface IntegrationEventJSON<
  T,
  E extends EventType = EventType,
> extends EventContext {
  readonly eventId: string;
  readonly eventType: E;
  readonly version: 1;
  readonly occurredAt: string;
  readonly data: Readonly<T>;
}
export type StoredIntegrationEvent = {
  [E in EventType]: IntegrationEventJSON<EventDataMap[E], E>;
}[EventType];

const text = z.string().min(1);
const contextSchema = z.object({
  aggregateId: text,
  correlationId: text,
  causationId: text.optional(),
});
const moneySchema = z
  .object({ amount: z.string(), currency: z.string() })
  .strict()
  .superRefine((value, ctx) => {
    try {
      Money.from(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "INVALID_EVENT_MONEY" });
    }
  });
const transactionFields = {
  transactionId: text,
  kind: z.enum(["OPENING", "BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
  balance: moneySchema,
};
const processedSchema = z
  .object({ ...transactionFields, status: z.literal("PROCESSED").optional() })
  .strict();
const rejectedSchema = z
  .object({
    ...transactionFields,
    status: z.literal("REJECTED"),
    failureCode: text,
  })
  .strict();
const pendingSchema = z
  .object({ ...transactionFields, status: z.literal("PENDING_REFERENCE") })
  .strict();
const changedSchema = z
  .object({
    walletId: text,
    transactionId: text,
    direction: z.enum(["CREDIT", "DEBIT"]),
    money: moneySchema,
    balanceBefore: moneySchema,
    balanceAfter: moneySchema,
    walletVersion: z.number().int().positive(),
  })
  .strict();
const header = {
  ...contextSchema.shape,
  eventId: text,
  version: z.literal(1),
  occurredAt: z.iso.datetime({ offset: true }),
};
const envelopeSchema = z.discriminatedUnion("eventType", [
  z
    .object({
      ...header,
      eventType: z.literal("WagerTransactionProcessed"),
      data: processedSchema,
    })
    .strict(),
  z
    .object({
      ...header,
      eventType: z.literal("WagerTransactionRejected"),
      data: rejectedSchema,
    })
    .strict(),
  z
    .object({
      ...header,
      eventType: z.literal("WagerTransactionPendingReference"),
      data: pendingSchema,
    })
    .strict(),
  z
    .object({
      ...header,
      eventType: z.literal("WalletBalanceChanged"),
      data: changedSchema,
    })
    .strict(),
]);
function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
// PostgreSQL JSON and broker input are unknown until the full envelope is checked.
export function parseIntegrationEvent(value: unknown): StoredIntegrationEvent {
  return freeze(envelopeSchema.parse(value));
}
export abstract class IntegrationEvent<T, E extends EventType = EventType> {
  abstract readonly eventType: E;
  abstract readonly version: 1;
  readonly eventId = crypto.randomUUID();
  private readonly timestamp = new Date().toISOString();
  readonly context: EventContext;
  readonly data: Readonly<T>;
  protected constructor(context: EventContext, data: T) {
    this.context = freeze(contextSchema.parse(context));
    this.data = freeze(data);
  }
  get occurredAt(): Date {
    return new Date(this.timestamp);
  }
  get aggregateId(): string {
    return this.context.aggregateId;
  }
  get correlationId(): string {
    return this.context.correlationId;
  }
  get causationId(): string | undefined {
    return this.context.causationId;
  }
  toJSON(): IntegrationEventJSON<T, E> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.context.aggregateId,
      correlationId: this.context.correlationId,
      ...(this.context.causationId === undefined
        ? {}
        : { causationId: this.context.causationId }),
      occurredAt: this.timestamp,
      data: this.data,
    };
  }
}
export class WagerTransactionProcessed extends IntegrationEvent<
  WagerTransactionProcessedData,
  "WagerTransactionProcessed"
> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;
  private constructor(ctx: EventContext, data: WagerTransactionProcessedData) {
    super(ctx, processedSchema.parse(data));
  }
  static from(ctx: EventContext, data: WagerTransactionProcessedData) {
    return new this(ctx, data);
  }
}
export class WagerTransactionRejected extends IntegrationEvent<
  WagerTransactionRejectedData,
  "WagerTransactionRejected"
> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;
  private constructor(ctx: EventContext, data: WagerTransactionRejectedData) {
    super(ctx, rejectedSchema.parse(data));
  }
  static from(ctx: EventContext, data: WagerTransactionRejectedData) {
    return new this(ctx, data);
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<
  WagerTransactionPendingReferenceData,
  "WagerTransactionPendingReference"
> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;
  private constructor(
    ctx: EventContext,
    data: WagerTransactionPendingReferenceData,
  ) {
    super(ctx, pendingSchema.parse(data));
  }
  static from(ctx: EventContext, data: WagerTransactionPendingReferenceData) {
    return new this(ctx, data);
  }
}
export class WalletBalanceChanged extends IntegrationEvent<
  WalletBalanceChangedData,
  "WalletBalanceChanged"
> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;
  private constructor(ctx: EventContext, data: WalletBalanceChangedData) {
    super(ctx, changedSchema.parse(data));
  }
  static from(ctx: EventContext, data: WalletBalanceChangedData) {
    return new this(ctx, data);
  }
}
export type WagerIntegrationEvent =
  | WagerTransactionProcessed
  | WagerTransactionRejected
  | WagerTransactionPendingReference
  | WalletBalanceChanged;
