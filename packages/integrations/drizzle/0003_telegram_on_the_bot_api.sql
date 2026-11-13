-- oxy:deploy-phase=pre
--
-- ADR 0037: Telegram moves to its official Bot API. The tables the new image needs before it
-- serves: `telegram_updates` (every delivered update, kept from acceptance until handled, so a
-- restart loses none) and the Telegram Business tables (the connections Telegram reports to the
-- shared bot, the sessions that link them to a gemie's connected account, and the private chats
-- and messages that arrive through them). New tables only; 0004 (post) drops the MTProto ones.
CREATE TABLE "telegram_business_chats" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"name" text NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" bigint NOT NULL,
	"last_message_preview" text DEFAULT '' NOT NULL,
	"last_incoming_at" bigint,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_business_connections" (
	"telegram_user_id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"user_chat_id" text NOT NULL,
	"username" text,
	"display_name" text,
	"is_enabled" boolean NOT NULL,
	"can_reply" boolean DEFAULT false NOT NULL,
	"rights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_business_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" text NOT NULL,
	"from_me" boolean NOT NULL,
	"sender_name" text,
	"text" text DEFAULT '' NOT NULL,
	"at" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_business_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"link_code" text,
	"link_code_expires_at" timestamp with time zone,
	"telegram_user_id" text,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"bot_id" text NOT NULL,
	"update_id" bigint NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "telegram_updates_bot_id_update_id_pk" PRIMARY KEY("bot_id","update_id"),
	CONSTRAINT "telegram_updates_status_check" CHECK ("telegram_updates"."status" in ('received', 'processing', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "telegram_business_chats" ADD CONSTRAINT "telegram_business_chats_session_id_telegram_business_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."telegram_business_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_business_messages" ADD CONSTRAINT "telegram_business_messages_session_id_telegram_business_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."telegram_business_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_business_chats_session_chat_key" ON "telegram_business_chats" USING btree ("session_id","chat_id");--> statement-breakpoint
CREATE INDEX "telegram_business_chats_session_recent_idx" ON "telegram_business_chats" USING btree ("session_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_business_connections_connection_key" ON "telegram_business_connections" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_business_messages_session_message_key" ON "telegram_business_messages" USING btree ("session_id","chat_id","message_id");--> statement-breakpoint
CREATE INDEX "telegram_business_messages_session_chat_recent_idx" ON "telegram_business_messages" USING btree ("session_id","chat_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "telegram_business_sessions_oxy_user_id_idx" ON "telegram_business_sessions" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_business_sessions_link_code_key" ON "telegram_business_sessions" USING btree ("link_code") WHERE "telegram_business_sessions"."link_code" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_business_sessions_telegram_user_key" ON "telegram_business_sessions" USING btree ("telegram_user_id") WHERE "telegram_business_sessions"."telegram_user_id" is not null;--> statement-breakpoint
CREATE INDEX "telegram_updates_pending_idx" ON "telegram_updates" USING btree ("updated_at") WHERE "telegram_updates"."status" in ('received', 'processing');