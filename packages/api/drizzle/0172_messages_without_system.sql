-- oxy:deploy-phase=post
--
-- What the saver's full rewrite left in stored conversations, cleaned where it can be.
--
--  1. A system message is the prompt of a turn, never a message of the conversation, and the
--     saver stored it whenever it rewrote a thread from a client's history: an embedding app's
--     context (Mention, Inbox, Mercaria… 48 conversations) and a channel's ("The user is chatting
--     via telegram…", a gemie bot's Telegram chat), each served to every client as the first
--     message. They go; 0173 narrows `messages_role_check` so none is stored again.
--  2. A rewrite stamped every message it reinserted with its own time, so a whole thread read as
--     written in one millisecond (that Telegram chat: 31 messages at 2026-11-14 09:15:32.470).
--     A message stamped like that (three or more messages of its conversation sharing one
--     instant) gets its real time back where the database still says it:
--       - its id is a UUIDv7 a client drew when the message was written: the time in the id;
--       - it is a gemie bot's Telegram message (`telegram:<chat>:<message>`): when its turn was
--         claimed (`gemie_bot_turns.created_at`), and the gemie's answer stored right after it,
--         when that turn was answered (`updated_at`);
--       - a gemie wrote it on its own (`agent-push-…`): when the person was notified of it.
--     Any other message keeps the instant it has: nothing records when it was written.
--  3. Positions are contiguous again (`seq` 0…n-1) in every conversation that lost a message
--     here or in 0170, so the saver's append fast path keeps applying to it.
--
-- POST: the image being replaced still stores system messages and rewrites threads until it has
-- drained.
DELETE FROM "messages" WHERE "role" NOT IN ('user', 'assistant');--> statement-breakpoint
WITH "flattened" AS (
  SELECT "m"."id", "m"."oxy_user_id", "m"."conversation_id", "m"."client_message_id", "m"."role",
    "m"."seq", "m"."content"
  FROM "messages" AS "m"
  JOIN (
    SELECT "oxy_user_id", "conversation_id", "created_at"
    FROM "messages"
    GROUP BY 1, 2, 3
    HAVING count(*) >= 3
  ) AS "g" USING ("oxy_user_id", "conversation_id", "created_at")
),
"turn_of" AS (
  SELECT "f"."id", "t"."created_at", "t"."updated_at", "t"."answer"
  FROM "flattened" AS "f"
  JOIN "gemie_bot_turns" AS "t"
    ON "f"."conversation_id" = 'telegram:' || "t"."bot_id" || ':' || "t"."chat_id"
   AND "f"."client_message_id" = 'telegram:' || "t"."chat_id" || ':' || "t"."message_id"
  WHERE "f"."role" = 'user'
),
"recovered" AS (
  SELECT "f"."id",
    to_timestamp(
      ('x' || substr(replace("f"."client_message_id", '-', ''), 1, 12))::bit(48)::bigint / 1000.0
    ) AS "at"
  FROM "flattened" AS "f"
  WHERE "f"."client_message_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  UNION ALL
  SELECT "id", "created_at" FROM "turn_of"
  UNION ALL
  SELECT "a"."id", "t"."updated_at"
  FROM "turn_of" AS "t"
  JOIN "flattened" AS "u" ON "u"."id" = "t"."id"
  JOIN "flattened" AS "a"
    ON "a"."oxy_user_id" = "u"."oxy_user_id"
   AND "a"."conversation_id" = "u"."conversation_id"
   AND "a"."seq" = "u"."seq" + 1
  WHERE "a"."role" = 'assistant'
    AND jsonb_typeof("a"."content") = 'string'
    AND "a"."content" #>> '{}' = "t"."answer" ->> 'reply'
  UNION ALL
  SELECT "f"."id", min("n"."created_at")
  FROM "flattened" AS "f"
  JOIN "notifications" AS "n"
    ON "n"."oxy_user_id" = "f"."oxy_user_id"
   AND "n"."conversation_id" = "f"."conversation_id"
   AND "n"."data" ->> 'messageId' = "f"."client_message_id"
  WHERE "f"."client_message_id" LIKE 'agent-push-%'
  GROUP BY "f"."id"
)
UPDATE "messages" AS "m"
SET "created_at" = "r"."at"
FROM "recovered" AS "r"
WHERE "m"."id" = "r"."id";--> statement-breakpoint
-- Two steps, because `messages_oxy_user_conversation_seq_key` is checked row by row: every
-- position of a gapped conversation goes negative (and so out of the way) before it takes its
-- final value.
WITH "gapped" AS (
  SELECT "oxy_user_id", "conversation_id"
  FROM (
    SELECT "oxy_user_id", "conversation_id", "seq",
      row_number() OVER (PARTITION BY "oxy_user_id", "conversation_id" ORDER BY "seq") - 1 AS "want"
    FROM "messages"
    WHERE "seq" IS NOT NULL
  ) AS "r"
  WHERE "want" <> "seq"
  GROUP BY 1, 2
)
UPDATE "messages" AS "m"
SET "seq" = -1 - "m"."seq"
FROM "gapped" AS "g"
WHERE "m"."oxy_user_id" = "g"."oxy_user_id"
  AND "m"."conversation_id" = "g"."conversation_id"
  AND "m"."seq" IS NOT NULL;--> statement-breakpoint
WITH "ranked" AS (
  SELECT "id",
    row_number() OVER (PARTITION BY "oxy_user_id", "conversation_id" ORDER BY "seq" DESC) - 1 AS "want"
  FROM "messages"
  WHERE "seq" < 0
)
UPDATE "messages" AS "m"
SET "seq" = "r"."want"
FROM "ranked" AS "r"
WHERE "m"."id" = "r"."id";
