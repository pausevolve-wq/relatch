-- Migration 001: skill history (runbook Section 11.3).
-- ALREADY APPLIED by hand as the owner, on `dev` and `production` (2026-10-21, 10/10 checks
-- each). This file is the source of truth for the schema; it is not run by the app, and the app's
-- role (relatch_app) cannot run it (no DDL).
-- Never stored: the source document, its file name, its extracted text.

CREATE TABLE IF NOT EXISTS skills (
  user_id     text        NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 64),
  id          text        NOT NULL CHECK (char_length(id)      BETWEEN 1 AND 64),
  name        text        NOT NULL CHECK (char_length(name)    BETWEEN 1 AND 120),
  target      text        NOT NULL CHECK (target IN ('claude', 'codex')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  seconds     real,
  degraded    boolean     NOT NULL DEFAULT false,
  files       jsonb       NOT NULL,            -- [{ "name", "content", "degraded" }]
  size_bytes  integer     NOT NULL CHECK (size_bytes BETWEEN 1 AND 262144),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS skills_user_recent ON skills (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON skills TO relatch_app;
GRANT SELECT                         ON skills TO relatch_backup;
