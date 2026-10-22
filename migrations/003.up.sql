ALTER TABLE wager_transaction
  ADD CONSTRAINT wager_transaction_id_wallet_unique UNIQUE (id, wallet_id);

ALTER TABLE ledger
  ADD CONSTRAINT ledger_transaction_wallet_fk
  FOREIGN KEY (transaction_id, wallet_id)
  REFERENCES wager_transaction (id, wallet_id);
