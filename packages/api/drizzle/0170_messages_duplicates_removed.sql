-- oxy:deploy-phase=pre
--
-- A message is stored once per thread (0171 makes the index that holds it). Before the index can
-- exist, the copies a channel stored twice go, with the reply each copy got.
--
-- A gemie bot's Telegram turn used to be saved by reconciling the history the channel sent, and a
-- retried delivery (before #106 ran a turn once) appended the same message again: in production on
-- 2026-11-14, `telegram:570038640:22` three times and `:25` twice in one conversation, each copy
-- followed by a different answer of the gemie. The FIRST copy of a message stays, with its reply.
-- A later copy goes, and so does every reply it got: the assistant messages after it, up to the
-- conversation's next message of the person, except what a gemie wrote on its own (`agent-push-`,
-- a room's `group-reply-`), which answered nothing. That was 3 copies and 3 replies, in one
-- conversation, when this was written.
--
-- PRE: the image being replaced keeps writing while this runs, and no new copy can appear: a
-- channel turn now reads the stored history, which this leaves without copies.
WITH "copies" AS (
  SELECT "id", "oxy_user_id", "conversation_id", "role", "seq",
    row_number() OVER (
      PARTITION BY "oxy_user_id", "conversation_id", "client_message_id"
      ORDER BY "seq" ASC NULLS FIRST, "created_at", "id"
    ) AS "copy"
  FROM "messages"
  WHERE "client_message_id" IS NOT NULL
),
"extra" AS (
  SELECT * FROM "copies" WHERE "copy" > 1
),
"replies" AS (
  SELECT "m"."id"
  FROM "extra" AS "e"
  JOIN "messages" AS "m"
    ON "m"."oxy_user_id" = "e"."oxy_user_id" AND "m"."conversation_id" = "e"."conversation_id"
  WHERE "e"."role" = 'user'
    AND "m"."role" = 'assistant'
    AND "m"."seq" > "e"."seq"
    AND coalesce("m"."client_message_id", '') NOT LIKE 'agent-push-%'
    AND coalesce("m"."client_message_id", '') NOT LIKE 'group-reply-%'
    AND NOT EXISTS (
      SELECT 1 FROM "messages" AS "u"
      WHERE "u"."oxy_user_id" = "e"."oxy_user_id"
        AND "u"."conversation_id" = "e"."conversation_id"
        AND "u"."role" = 'user'
        AND "u"."seq" > "e"."seq"
        AND "u"."seq" < "m"."seq"
    )
)
DELETE FROM "messages"
WHERE "id" IN (SELECT "id" FROM "extra" UNION SELECT "id" FROM "replies");
