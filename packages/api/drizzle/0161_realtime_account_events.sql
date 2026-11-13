-- oxy:deploy-phase=pre
--
-- Realtime (docs/realtime.mdx): the per-account event log a reconnecting socket catches up from,
-- and the sidebar's unread count. Only additive: the image being replaced neither reads nor writes
-- any of it.
--
--  1. `account_event_heads` holds each account's newest event number; `account_events` the events,
--     numbered 1, 2, 3… per account in commit order, swept after three days.
--  2. `conversations.unread_count`, with a constant default: a metadata-only change, no rewrite and no
--     scan of the hot table.
CREATE TABLE "account_event_heads" (
	"oxy_user_id" text PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	CONSTRAINT "account_event_heads_seq_check" CHECK ("account_event_heads"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "account_events" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "account_events_type_check" CHECK ("account_events"."type" in ('conversation', 'conversation.deleted', 'message.reaction', 'gemies', 'credits', 'notification', 'connections'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "unread_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "account_events_oxy_user_seq_key" ON "account_events" USING btree ("oxy_user_id","seq");--> statement-breakpoint
CREATE INDEX "account_events_created_at_idx" ON "account_events" USING btree ("created_at");