ALTER TABLE api_keys ADD COLUMN paired INTEGER NOT NULL DEFAULT 0 CHECK(paired IN (0,1));
CREATE INDEX paired_clients_by_creation ON api_keys(created_at DESC,id DESC) WHERE paired=1 AND session=1;
ALTER TABLE pair_codes ADD COLUMN client_name TEXT NOT NULL DEFAULT '';
ALTER TABLE pair_codes ADD COLUMN issuer_id TEXT REFERENCES api_keys(id) ON DELETE CASCADE;
