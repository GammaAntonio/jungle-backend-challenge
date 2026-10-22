export interface MoneyProps {
  amount: string;
  currency: string;
}
export class DomainError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
const currencies = new Set(Intl.supportedValuesOf("currency"));
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }
  static from(p: MoneyProps): Money {
    if (
      !p ||
      typeof p.amount !== "string" ||
      !/^(0|[1-9]\d{0,15})\.\d{2}$/.test(p.amount) ||
      !currencies.has(p.currency)
    )
      throw new DomainError("INVALID_MONEY");
    return new Money(BigInt(p.amount.replace(".", "")), p.currency);
  }
  static zero(currency: string) {
    return Money.from({ amount: "0.00", currency });
  }
  private same(m: Money) {
    if (this.currency !== m.currency)
      throw new DomainError("CURRENCY_MISMATCH");
  }
  private result(c: bigint) {
    if (c >= 10n ** 18n || c <= -(10n ** 18n))
      throw new DomainError("MONEY_OVERFLOW");
    return new Money(c, this.currency);
  }
  add(m: Money) {
    this.same(m);
    return this.result(this.cents + m.cents);
  }
  canAdd(m: Money) {
    this.same(m);
    const next = this.cents + m.cents;
    return next < 10n ** 18n && next > -(10n ** 18n);
  }
  subtract(m: Money) {
    this.same(m);
    return this.result(this.cents - m.cents);
  }
  negate() {
    return this.result(-this.cents);
  }
  equals(m: Money) {
    this.same(m);
    return this.cents === m.cents;
  }
  isLessThan(m: Money) {
    this.same(m);
    return this.cents < m.cents;
  }
  isZero() {
    return this.cents === 0n;
  }
  isPositive() {
    return this.cents > 0n;
  }
  isNegative() {
    return this.cents < 0n;
  }
  toString() {
    const c = this.cents < 0n ? -this.cents : this.cents;
    return `${this.cents < 0n ? "-" : ""}${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;
  }
  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }
}
export type Direction = "DEBIT" | "CREDIT";
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date = new Date(),
    private _updatedAt: Date = new Date(),
  ) {}
  static open(p: { id: string; playerId: string; initialBalance: Money }) {
    if (p.initialBalance.isNegative())
      throw new DomainError("NEGATIVE_BALANCE");
    return new Wallet(p.id, p.playerId, p.initialBalance, 1);
  }
  static rehydrate(p: {
    id: string;
    playerId: string;
    balance: Money;
    version: number;
    createdAt?: Date;
    updatedAt?: Date;
  }) {
    return new Wallet(
      p.id,
      p.playerId,
      p.balance,
      p.version,
      p.createdAt,
      p.updatedAt,
    );
  }
  get balance() {
    return this._balance;
  }
  get version() {
    return this._version;
  }
  get currency() {
    return this._balance.currency;
  }
  get updatedAt() {
    return this._updatedAt;
  }
  debit(m: Money) {
    if (m.isNegative()) throw new DomainError("INVALID_MONEY");
    const next = this._balance.subtract(m);
    if (next.isNegative()) throw new DomainError("INSUFFICIENT_FUNDS");
    this.change(next);
  }
  credit(m: Money) {
    if (m.isNegative()) throw new DomainError("INVALID_MONEY");
    this.change(this._balance.add(m));
  }
  private change(m: Money) {
    if (!this._balance.equals(m)) {
      this._balance = m;
      this._version++;
      this._updatedAt = new Date();
    }
  }
}
export type Kind = "OPENING" | "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
export type Status =
  "PENDING" | "PENDING_REFERENCE" | "PROCESSED" | "REJECTED" | "FAILED";
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly kind: Kind,
    private _status: Status,
    private _failureCode?: string,
    private _referenceTransactionId?: string,
    private _processedAt?: Date,
    public readonly payloadHash: string = "",
  ) {}
  static create(id: string, kind: Kind, reference?: string) {
    if (["REFUND", "ROLLBACK"].includes(kind) && !reference)
      throw new DomainError("REFERENCE_REQUIRED");
    return new WagerTransaction(id, kind, "PENDING");
  }
  static rehydrate(p: {
    id: string;
    kind: Kind;
    status: Status;
    failureCode?: string;
    referenceTransactionId?: string;
    processedAt?: Date;
    payloadHash?: string;
  }) {
    return new WagerTransaction(
      p.id,
      p.kind,
      p.status,
      p.failureCode,
      p.referenceTransactionId,
      p.processedAt,
      p.payloadHash,
    );
  }
  get status() {
    return this._status;
  }
  get failureCode() {
    return this._failureCode;
  }
  isTerminal() {
    return ["PROCESSED", "REJECTED", "FAILED"].includes(this._status);
  }
  private transition(s: Status, c?: string) {
    if (this.isTerminal()) throw new DomainError("INVALID_TRANSACTION_STATE");
    this._status = s;
    this._failureCode = c;
  }
  get referenceTransactionId() {
    return this._referenceTransactionId;
  }
  get processedAt() {
    return this._processedAt;
  }
  affectsBalance() {
    return this.kind !== "LOSS";
  }
  requiresReference() {
    return this.kind === "REFUND" || this.kind === "ROLLBACK";
  }
  matchesPayload(hash: string) {
    return hash === this.payloadHash;
  }
  ledgerDirectionFor(reference?: WagerTransaction): Direction | undefined {
    if (!this.affectsBalance()) return undefined;
    if (this.kind === "BET") return "DEBIT";
    if (this.kind === "ROLLBACK") {
      if (!reference || !["BET", "WIN", "REFUND"].includes(reference.kind))
        throw new DomainError("REFERENCE_KIND_INVALID");
      return reference.kind === "BET" ? "CREDIT" : "DEBIT";
    }
    return "CREDIT";
  }
  markProcessed(referenceTransactionId?: string, at = new Date()) {
    this.transition("PROCESSED");
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }
  markPendingReference() {
    this.transition("PENDING_REFERENCE");
  }
  reject(c: string) {
    this.transition("REJECTED", c);
  }
  fail(c: string) {
    this.transition("FAILED", c);
  }
}
export class WalletLedgerEntry {
  private constructor(
    public readonly direction: Direction,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
  ) {
    Object.freeze(this);
  }
  static create(p: {
    direction: Direction;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
  }) {
    const e = new WalletLedgerEntry(
      p.direction,
      p.money,
      p.balanceBefore,
      p.balanceAfter,
    );
    if (!e.isBalanced() || !p.money.isPositive() || p.balanceAfter.isNegative())
      throw new DomainError("UNBALANCED_LEDGER");
    return e;
  }
  static rehydrate(p: {
    direction: Direction;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
  }) {
    return new WalletLedgerEntry(
      p.direction,
      p.money,
      p.balanceBefore,
      p.balanceAfter,
    );
  }
  isBalanced() {
    return (
      this.direction === "CREDIT"
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money)
    ).equals(this.balanceAfter);
  }
}
