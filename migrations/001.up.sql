CREATE TABLE wallet (id uuid PRIMARY KEY, player_id uuid NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), balance numeric(18,2) NOT NULL CHECK(balance>=0), version integer NOT NULL CHECK(version>=1), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(player_id,currency));
CREATE TABLE wager_transaction (id uuid PRIMARY KEY, provider_id text NOT NULL, external_id text NOT NULL, idempotency_key text NOT NULL, payload_hash text NOT NULL, wallet_id uuid NOT NULL REFERENCES wallet, player_id uuid NOT NULL, round_id text NOT NULL, game_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')), amount numeric(18,2) NOT NULL CHECK(amount>=0), currency text NOT NULL, reference_external_id text, reference_id uuid REFERENCES wager_transaction, status text NOT NULL CHECK(status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')), failure_code text, response jsonb, request jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, UNIQUE(provider_id,external_id), UNIQUE(provider_id,idempotency_key), CHECK(kind NOT IN ('REFUND','ROLLBACK') OR reference_external_id IS NOT NULL));
CREATE UNIQUE INDEX reversal_once ON wager_transaction(reference_id,kind) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK');
CREATE INDEX pending_due ON wager_transaction(next_attempt_at) WHERE status='PENDING_REFERENCE';
CREATE TABLE ledger (sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id uuid NOT NULL UNIQUE, wallet_id uuid NOT NULL REFERENCES wallet, transaction_id uuid NOT NULL REFERENCES wager_transaction, direction text NOT NULL CHECK(direction IN ('DEBIT','CREDIT')), amount numeric(18,2) NOT NULL CHECK(amount>0), currency text NOT NULL, balance_before numeric(18,2) NOT NULL CHECK(balance_before>=0), balance_after numeric(18,2) NOT NULL CHECK(balance_after>=0), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(transaction_id,wallet_id), CHECK(balance_after=balance_before+CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END));
CREATE INDEX ledger_wallet_sequence ON ledger(wallet_id,sequence);
CREATE FUNCTION immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable record'; END $$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON ledger FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION terminal_transaction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN RAISE EXCEPTION 'terminal transaction'; END IF; RETURN NEW; END $$;
CREATE TRIGGER transaction_terminal BEFORE UPDATE OR DELETE ON wager_transaction FOR EACH ROW EXECUTE FUNCTION terminal_transaction();
CREATE TABLE inbox (consumer_name text NOT NULL, message_id text NOT NULL, payload_hash text NOT NULL, transaction_id uuid NOT NULL REFERENCES wager_transaction, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(consumer_name,message_id));
CREATE TABLE outbox (id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), claim_token uuid, claimed_until timestamptz, published_at timestamptz);
CREATE INDEX outbox_due ON outbox(next_attempt_at) WHERE published_at IS NULL;
CREATE FUNCTION assert_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE wid uuid; stored numeric; calculated numeric; BEGIN IF TG_TABLE_NAME='wallet' THEN wid:=NEW.id; ELSE wid:=NEW.wallet_id; END IF; SELECT balance INTO stored FROM wallet WHERE id=wid; SELECT COALESCE(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0) INTO calculated FROM ledger WHERE wallet_id=wid; IF stored IS DISTINCT FROM calculated THEN RAISE EXCEPTION 'wallet ledger mismatch'; END IF; RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER wallet_balanced AFTER INSERT OR UPDATE ON wallet DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_wallet_ledger();
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_wallet_ledger();

CREATE FUNCTION validate_ledger_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wallet_currency text; previous_balance numeric; BEGIN
  SELECT currency INTO wallet_currency FROM wallet WHERE id=NEW.wallet_id FOR UPDATE;
  IF NEW.currency<>wallet_currency THEN RAISE EXCEPTION 'ledger currency mismatch'; END IF;
  SELECT balance_after INTO previous_balance FROM ledger WHERE wallet_id=NEW.wallet_id ORDER BY sequence DESC LIMIT 1;
  IF NEW.balance_before<>COALESCE(previous_balance,0) THEN RAISE EXCEPTION 'ledger chain mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_chain BEFORE INSERT ON ledger FOR EACH ROW EXECUTE FUNCTION validate_ledger_insert();
CREATE FUNCTION assert_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid uuid; t wager_transaction%ROWTYPE; entry ledger%ROWTYPE; reference_kind text; expected_direction text; BEGIN
  IF TG_TABLE_NAME='ledger' THEN tid:=NEW.transaction_id; ELSE tid:=NEW.id; END IF;
  SELECT * INTO t FROM wager_transaction WHERE id=tid;
  SELECT * INTO entry FROM ledger WHERE transaction_id=tid;
  IF t.status='PROCESSED' AND t.kind<>'LOSS' AND t.amount>0 THEN
    IF entry.id IS NULL OR entry.wallet_id<>t.wallet_id OR entry.amount<>t.amount OR entry.currency<>t.currency THEN RAISE EXCEPTION 'transaction ledger mismatch'; END IF;
    SELECT kind INTO reference_kind FROM wager_transaction WHERE id=t.reference_id;
    expected_direction:=CASE WHEN t.kind='BET' OR (t.kind='ROLLBACK' AND reference_kind IN ('WIN','REFUND')) THEN 'DEBIT' ELSE 'CREDIT' END;
    IF entry.direction<>expected_direction THEN RAISE EXCEPTION 'ledger direction mismatch'; END IF;
  ELSIF entry.id IS NOT NULL THEN RAISE EXCEPTION 'unexpected ledger entry'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transaction_has_ledger AFTER INSERT OR UPDATE ON wager_transaction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_transaction_ledger();
CREATE CONSTRAINT TRIGGER ledger_matches_transaction AFTER INSERT ON ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_transaction_ledger();
