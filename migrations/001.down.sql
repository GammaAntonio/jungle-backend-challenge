DROP TABLE outbox,inbox,ledger,wager_transaction,wallet CASCADE;
DROP FUNCTION assert_wallet_ledger();
DROP FUNCTION terminal_transaction();
DROP FUNCTION immutable_record();
DROP FUNCTION validate_ledger_insert();
DROP FUNCTION assert_transaction_ledger();
