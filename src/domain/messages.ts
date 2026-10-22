import {
  parseIntegrationEvent,
  type StoredIntegrationEvent,
  type WagerIntegrationEvent,
  type EventType,
} from "./events";

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}
  static receive(p: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
  }) {
    return new InboxMessage(
      p.messageId,
      p.consumerName,
      p.payloadHash,
      new Date(),
    );
  }
  static rehydrate(p: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt: Date;
    processedAt?: Date;
  }) {
    return new InboxMessage(
      p.messageId,
      p.consumerName,
      p.payloadHash,
      p.receivedAt,
      p.processedAt,
    );
  }
  get processedAt() {
    return this._processedAt;
  }
  isProcessed() {
    return this._processedAt !== undefined;
  }
  markProcessed(at: Date) {
    if (this.isProcessed()) throw Error("INBOX_ALREADY_PROCESSED");
    this._processedAt = at;
  }
}
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: EventType,
    public readonly payload: StoredIntegrationEvent,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}
  static enqueue(event: WagerIntegrationEvent) {
    const p = parseIntegrationEvent(event.toJSON());
    return new OutboxMessage(
      p.eventId,
      p.aggregateId,
      p.eventType,
      Object.freeze(p),
      new Date(p.occurredAt),
      0,
    );
  }
  static rehydrate(p: {
    id: string;
    aggregateId: string;
    eventType: string;
    payload: unknown;
    occurredAt: Date;
    attempts: number;
    nextAttemptAt?: Date;
    publishedAt?: Date;
  }) {
    const payload = parseIntegrationEvent(p.payload);
    if (
      payload.eventId !== p.id ||
      payload.aggregateId !== p.aggregateId ||
      payload.eventType !== p.eventType
    )
      throw Error("OUTBOX_EVENT_IDENTITY_MISMATCH");
    return new OutboxMessage(
      p.id,
      p.aggregateId,
      payload.eventType,
      payload,
      p.occurredAt,
      p.attempts,
      p.nextAttemptAt,
      p.publishedAt,
    );
  }
  get attempts() {
    return this._attempts;
  }
  get nextAttemptAt() {
    return this._nextAttemptAt;
  }
  get publishedAt() {
    return this._publishedAt;
  }
  isPending() {
    return !this._publishedAt;
  }
  isDue(now: Date) {
    return (
      this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt <= now)
    );
  }
  markPublished(at: Date) {
    this._publishedAt = at;
  }
  scheduleRetry(now: Date) {
    this._attempts++;
    this._nextAttemptAt = new Date(
      now.getTime() + Math.min(3600, 2 ** Math.min(this._attempts, 12)) * 1000,
    );
  }
}
