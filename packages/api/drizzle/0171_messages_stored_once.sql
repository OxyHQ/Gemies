-- oxy:deploy-phase=pre
--
-- A message is stored once per thread: `(oxy_user_id, conversation_id, client_message_id)` is
-- unique (NULL ids, a legacy webhook's rows, stay distinct). 0170 removed the copies there were.
-- The saver appends only the ids a thread lacks and retries a conflict on this index, so a channel's
-- retried delivery keeps its message once (`lib/conversation-saver.ts`).
--
-- PRE: the new image's appends name this index as a conflict to retry; the image being replaced
-- never produces one now that 0170 left no copies to reconcile from.
--
-- ## LOCKS
--
-- `messages` is hot. drizzle runs a migration inside a transaction, where CONCURRENTLY is
-- impossible, so the index is IF NOT EXISTS: on a table large enough for its build to matter it is
-- built out of band first, and this statement is then a no-op —
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS messages_oxy_user_conversation_client_message_key ON messages USING btree (oxy_user_id, conversation_id, client_message_id);
--
-- Production held 1,048 messages when this was written (2026-11-14): the in-migration build holds
-- SHARE on it for milliseconds. A failed CONCURRENTLY build leaves an INVALID index, which IF NOT
-- EXISTS would silently keep: the guard refuses one.
CREATE UNIQUE INDEX IF NOT EXISTS "messages_oxy_user_conversation_client_message_key" ON "messages" USING btree ("oxy_user_id","conversation_id","client_message_id");--> statement-breakpoint
DO $$
DECLARE
  invalid text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO invalid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname = 'messages_oxy_user_conversation_client_message_key'
    AND NOT i.indisvalid;
  IF invalid IS NOT NULL THEN
    RAISE EXCEPTION 'messages index not valid: %. A CREATE INDEX CONCURRENTLY failed part-way; DROP INDEX CONCURRENTLY it and build it again before migrating.', invalid;
  END IF;
END $$;
