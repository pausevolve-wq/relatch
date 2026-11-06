-- Migration 002: the Agents target (2026-11-02, the V3 Agents tab; relatch api/enrich.js AGENTS_TARGET).
-- APPLIED 2026-11-06 on Manas's go: `dev`, then `production` (14/14 lifecycle test on a throwaway copy first,
-- jev-harness/db-tests/m002-test.ps1). Was: NOT APPLIED. Run by hand as the owner, on `dev` first, then `production`, only after Manas says go
-- (like 001: the app's role relatch_app has no DDL). Before it runs, api/skills.js accepts 'agents' but
-- the CHECK below still refuses the row, so the app keeps Agents skills in the browser only.
-- Postgres named 001's inline CHECK skills_target_check; IF EXISTS keeps a re-run harmless.
-- Rollback: the same two statements with ('claude', 'codex'), after deleting or re-targeting any
-- 'agents' rows (the ADD fails while one exists).

BEGIN;
ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_target_check;
ALTER TABLE skills ADD CONSTRAINT skills_target_check CHECK (target IN ('claude', 'codex', 'agents'));
COMMIT;
