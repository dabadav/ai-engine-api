-- Enable UUID gen if you want DB-side defaults (optional)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- visitor table
CREATE TABLE IF NOT EXISTS visitor (
  id                  BIGINT PRIMARY KEY,
  email               TEXT UNIQUE,
  password_hash       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  age                 INTEGER,
  nationality         TEXT,
  personal_connection INTEGER,
  payload             TEXT
);

-- device table
CREATE TABLE IF NOT EXISTS device (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         BIGINT REFERENCES visitor(id),
  device_id_token TEXT UNIQUE NOT NULL,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ,
  last_ip         INET
);

-- session table
CREATE TABLE IF NOT EXISTS session (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       BIGINT REFERENCES visitor(id),
  device_id     UUID REFERENCES device(id),
  session_token TEXT UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  ip            INET,
  user_agent    TEXT,
  is_revoked    BOOLEAN NOT NULL DEFAULT FALSE
);

-- visitor_event table
CREATE TABLE IF NOT EXISTS visitor_event (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT REFERENCES visitor(id),
  session_id    UUID REFERENCES session(id),
  item_id       TEXT,
  event_type    TEXT NOT NULL,
  event_payload JSONB,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_visitor_event_user_id_ts
  ON visitor_event (user_id, ts);

CREATE INDEX IF NOT EXISTS ix_visitor_event_session_id_ts
  ON visitor_event (session_id, ts);
