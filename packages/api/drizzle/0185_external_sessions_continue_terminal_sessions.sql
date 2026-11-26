-- oxy:deploy-phase=pre
--
-- ADR 0043 §4: a session opened from the app may continue one begun in a terminal. A nullable column
-- on `external_agent_sessions`, a table created one migration earlier that nothing reads or writes
-- before this release.
ALTER TABLE "external_agent_sessions" ADD COLUMN "cli_session_id" text;