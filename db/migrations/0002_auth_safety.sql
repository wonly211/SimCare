ALTER TABLE recovery_tickets ADD COLUMN issuer_id TEXT REFERENCES users(id);
CREATE TABLE auth_rate_limits (key_hash TEXT NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (key_hash,bucket));
