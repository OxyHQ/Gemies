-- oxy:deploy-phase=pre
--
-- ADR 0037: a gemie bot's turn runs once per Telegram message, whatever the integrations process
-- retries. A new, empty table.
CREATE TABLE "gemie_bot_turns" (
	"bot_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"answer" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "gemie_bot_turns_bot_id_chat_id_message_id_pk" PRIMARY KEY("bot_id","chat_id","message_id"),
	CONSTRAINT "gemie_bot_turns_status_check" CHECK ("gemie_bot_turns"."status" in ('running', 'answered'))
);
--> statement-breakpoint
CREATE INDEX "gemie_bot_turns_created_idx" ON "gemie_bot_turns" USING btree ("created_at");