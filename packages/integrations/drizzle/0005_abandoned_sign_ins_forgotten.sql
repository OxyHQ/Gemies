-- oxy:deploy-phase=post
--
-- A connector's sign-in that never finished leaves a record with a registered client and a PKCE
-- verifier and no tokens. Each Connect of a new account now begins its own record, and
-- `forgetAbandonedAuthorizations` clears a person's unfinished ones when they start another; this
-- clears those left before it. An hour is well past the API's ten-minute OAuth state, after which no
-- such sign-in can complete. Production held 1 (an abandoned Notion connect) when this was written.
DELETE FROM "mcp_connector_auths"
WHERE "tokens" IS NULL AND "updated_at" < now() - interval '1 hour';
