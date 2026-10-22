import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
} from "../../src/domain/events";
import { Money } from "../../src/domain/model";
import { OutboxMessage } from "../../src/domain/messages";
import { sendIntegrationEvent } from "../../src/infrastructure/sqs";

// Checked by the real project tsc; never executed by Bun's test runner.
export function eventContractTypeAssertions() {
  const ctx = { aggregateId: "wallet", correlationId: "correlation" };
  const money = { amount: "1.00", currency: "BRL" };
  const changed = {
    walletId: "wallet",
    transactionId: "transaction",
    direction: "CREDIT" as const,
    money,
    balanceBefore: money,
    balanceAfter: money,
    walletVersion: 1,
  };
  // @ts-expect-error Processed requires transactionId, kind and balance.
  WagerTransactionProcessed.from(ctx, {});
  // @ts-expect-error Rejected requires a business failure and transaction data.
  WagerTransactionRejected.from(ctx, {});
  // @ts-expect-error PendingReference requires transaction data.
  WagerTransactionPendingReference.from(ctx, {});
  // @ts-expect-error BalanceChanged requires all seven data fields.
  WalletBalanceChanged.from(ctx, { money });
  const modelMoney = { ...changed, money: Money.from(money) };
  // @ts-expect-error Money instances are not MoneyProps.
  WalletBalanceChanged.from(ctx, modelMoney);
  const bigintMoney = { ...changed, money: { amount: 100n, currency: "BRL" } };
  // @ts-expect-error Financial JSON amounts cannot be bigint.
  WalletBalanceChanged.from(ctx, bigintMoney);
  const numericMoney = {
    ...changed,
    balanceAfter: { amount: 1, currency: "BRL" },
  };
  // @ts-expect-error Financial JSON amounts cannot be number.
  WalletBalanceChanged.from(ctx, numericMoney);
  const wrongDirection = { ...changed, direction: "OUT" };
  // @ts-expect-error Direction is CREDIT or DEBIT.
  WalletBalanceChanged.from(ctx, wrongDirection);
  const wrongVersion = { ...changed, walletVersion: "1" };
  // @ts-expect-error Wallet version is an integer number, never a string.
  WalletBalanceChanged.from(ctx, wrongVersion);
  const processedModel = {
    transactionId: "t",
    kind: "WIN" as const,
    balance: Money.from(money),
  };
  // @ts-expect-error Processed balance must also be MoneyProps.
  WagerTransactionProcessed.from(ctx, processedModel);
  const invalidFailure = {
    transactionId: "t",
    kind: "BET" as const,
    balance: money,
    status: "REJECTED" as const,
    failureCode: 42,
  };
  // @ts-expect-error Failure codes must be strings.
  WagerTransactionRejected.from(ctx, invalidFailure);
  const missingCurrency = {
    transactionId: "t",
    kind: "REFUND" as const,
    balance: { amount: "1.00" },
    status: "PENDING_REFERENCE" as const,
  };
  // @ts-expect-error PendingReference balance requires currency.
  WagerTransactionPendingReference.from(ctx, missingCurrency);
  const invalidKind = {
    transactionId: "t",
    kind: "CREDIT" as const,
    balance: money,
  };
  // @ts-expect-error CREDIT is a ledger direction, not a transaction kind.
  WagerTransactionProcessed.from(ctx, invalidKind);
  const wrongStatus = {
    transactionId: "t",
    kind: "BET" as const,
    balance: money,
    status: "REJECTED" as const,
  };
  // @ts-expect-error A processed event cannot contain REJECTED status.
  WagerTransactionProcessed.from(ctx, wrongStatus);
  const noFailure = {
    transactionId: "t",
    kind: "BET" as const,
    balance: money,
    status: "REJECTED" as const,
  };
  // @ts-expect-error A rejected event must carry failureCode.
  WagerTransactionRejected.from(ctx, noFailure);
  const wrongPending = {
    transactionId: "t",
    kind: "REFUND" as const,
    balance: money,
    status: "PROCESSED" as const,
  };
  // @ts-expect-error A pending-reference event cannot contain terminal status.
  WagerTransactionPendingReference.from(ctx, wrongPending);
  // @ts-expect-error Constructors are private: validated factory is mandatory.
  new WalletBalanceChanged(ctx, changed);
  // @ts-expect-error A structural partial serializer is not a concrete event.
  OutboxMessage.enqueue({ toJSON: () => ({ eventId: "e" }) });
  const incompatibleEnvelope = {
    eventId: "e",
    aggregateId: "w",
    correlationId: "c",
    occurredAt: new Date().toISOString(),
    version: 1 as const,
    eventType: "WagerTransactionRejected" as const,
    data: { ...changed },
  };
  // @ts-expect-error Publication preserves the eventType/data discriminated union.
  void sendIntegrationEvent(incompatibleEnvelope);
  const valid = WalletBalanceChanged.from(ctx, changed).toJSON();
  const literalType: "WalletBalanceChanged" = valid.eventType;
  const literalVersion: 1 = valid.version;
  const decimalString: string = valid.data.money.amount;
  // @ts-expect-error Nested monetary payloads are readonly.
  valid.data.money.amount = "2.00";
  return { literalType, literalVersion, decimalString };
}
