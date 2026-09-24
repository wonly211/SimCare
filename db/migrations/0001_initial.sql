PRAGMA foreign_keys = ON;

CREATE TABLE household (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE system_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), initialized INTEGER NOT NULL DEFAULT 0,
  household_id TEXT REFERENCES household(id), epoch TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO system_settings (id, epoch) VALUES (1, 'uninitialized');
CREATE TABLE users (
  id TEXT PRIMARY KEY, nickname TEXT NOT NULL, system_role TEXT CHECK (system_role IS NULL OR system_role = 'system_admin'),
  active INTEGER NOT NULL CHECK (active IN (0,1)), created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_system_admin ON users(system_role) WHERE system_role = 'system_admin';
CREATE TABLE household_members (
  user_id TEXT PRIMARY KEY REFERENCES users(id), household_id TEXT NOT NULL REFERENCES household(id),
  role TEXT NOT NULL CHECK (role IN ('admin','member')), active INTEGER NOT NULL CHECK (active IN (0,1))
);
CREATE TABLE credentials (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), public_key TEXT NOT NULL, counter INTEGER NOT NULL,
  device_type TEXT NOT NULL, backed_up INTEGER NOT NULL, transports TEXT NOT NULL, name TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, verified_at TEXT NOT NULL);
CREATE TABLE invitations (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('admin','member')),
  created_by TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT
);
CREATE TABLE challenges (
  id TEXT PRIMARY KEY, challenge TEXT NOT NULL, kind TEXT NOT NULL, user_id TEXT, nickname TEXT,
  token_hash TEXT, expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE recovery_codes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), code_hash TEXT NOT NULL UNIQUE, used_at TEXT);
CREATE TABLE recovery_tickets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE qr_logins (id TEXT PRIMARY KEY, scan_hash TEXT NOT NULL, poll_hash TEXT NOT NULL, expires_at TEXT NOT NULL, approved_user_id TEXT REFERENCES users(id), used_at TEXT);
CREATE TABLE member_permissions (
  owner_id TEXT NOT NULL REFERENCES users(id), grantee_id TEXT NOT NULL REFERENCES users(id),
  permission TEXT NOT NULL CHECK (permission IN ('none','view','care')), PRIMARY KEY (owner_id, grantee_id), CHECK (owner_id <> grantee_id)
);
CREATE TABLE health_records (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL CHECK (json_valid(data)), version INTEGER NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX health_owner_date ON health_records(owner_id, updated_at);
CREATE TABLE medications (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL CHECK (json_valid(data)), version INTEGER NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE medication_schedules (id TEXT PRIMARY KEY, medication_id TEXT NOT NULL REFERENCES medications(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK (json_valid(data)));
CREATE TABLE record_revisions (
  id TEXT PRIMARY KEY, resource TEXT NOT NULL CHECK (resource IN ('health','medication')), record_id TEXT NOT NULL, version INTEGER NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)), actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE (resource, record_id, version)
);
CREATE TABLE sync_operations (operation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), payload_hash TEXT NOT NULL, result TEXT NOT NULL CHECK (json_valid(result)), created_at TEXT NOT NULL);
CREATE TABLE atomic_checks (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK (valid = 1));
CREATE TABLE restore_previews (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), mode TEXT NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE restore_snapshots (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
