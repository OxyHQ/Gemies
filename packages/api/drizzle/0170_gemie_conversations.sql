-- oxy:deploy-phase=pre
--
-- ADR 0041: gemies talk to each other in a conversation of their own, owned by the person they
-- both work for. A new table, so nothing running reads or writes it before this release.
CREATE TABLE "gemie_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"first_agent_id" text NOT NULL,
	"second_agent_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "gemie_conversations_pair_order_check" CHECK ("gemie_conversations"."first_agent_id" < "gemie_conversations"."second_agent_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gemie_conversations_conversation_key" ON "gemie_conversations" USING btree ("oxy_user_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gemie_conversations_pair_key" ON "gemie_conversations" USING btree ("oxy_user_id","first_agent_id","second_agent_id");