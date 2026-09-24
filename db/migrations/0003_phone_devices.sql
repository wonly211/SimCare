ALTER TABLE users ADD COLUMN phone TEXT CHECK (phone IS NULL OR (length(phone)=11 AND phone NOT GLOB '*[^0-9]*' AND substr(phone,1,1)='1'));
CREATE UNIQUE INDEX users_phone ON users(phone) WHERE phone IS NOT NULL;
ALTER TABLE sessions ADD COLUMN device_id TEXT;
ALTER TABLE sessions ADD COLUMN device_name TEXT NOT NULL DEFAULT '已登录设备';
ALTER TABLE sessions ADD COLUMN renewed_at TEXT;
CREATE UNIQUE INDEX sessions_device ON sessions(device_id) WHERE device_id IS NOT NULL;
CREATE TABLE login_requests (
  id TEXT PRIMARY KEY, phone TEXT NOT NULL, nickname TEXT NOT NULL,
  device_name TEXT NOT NULL, poll_hash TEXT NOT NULL, invitation_hash TEXT,
  user_id TEXT REFERENCES users(id), approved_by TEXT REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','claimed')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX login_requests_status ON login_requests(status, expires_at);
