-- oxy:deploy-phase=pre
--
-- A person's folders, projects, pins and favourites move from each device to their account
-- (docs/realtime.mdx, "Collections"). Only additive for the image being replaced:
--
--  1. `conversation_collections` (folders and projects) and `conversation_collection_items` (which
--     conversations each holds; the memberships go with their collection).
--  2. `conversations.pinned_at`, nullable: a metadata-only change on the hot table.
--  3. `account_events_type_check` widened with `collections`, which only the new image writes. The
--     table is three days of events, so the re-check is short.
CREATE TABLE "conversation_collection_items" (
	"id" text PRIMARY KEY NOT NULL,
	"collection_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_collections" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"color" text,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"is_expanded" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "conversation_collections_kind_check" CHECK ("conversation_collections"."kind" in ('folder', 'project'))
);
--> statement-breakpoint
ALTER TABLE "account_events" DROP CONSTRAINT "account_events_type_check";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_collection_items" ADD CONSTRAINT "conversation_collection_items_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."conversation_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_collection_items_collection_conversation_key" ON "conversation_collection_items" USING btree ("collection_id","conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_collection_items_oxy_user_conversation_idx" ON "conversation_collection_items" USING btree ("oxy_user_id","conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_collections_oxy_user_created_at_idx" ON "conversation_collections" USING btree ("oxy_user_id","created_at");--> statement-breakpoint
ALTER TABLE "account_events" ADD CONSTRAINT "account_events_type_check" CHECK ("account_events"."type" in ('conversation', 'conversation.deleted', 'message.reaction', 'gemies', 'credits', 'notification', 'connections', 'collections'));