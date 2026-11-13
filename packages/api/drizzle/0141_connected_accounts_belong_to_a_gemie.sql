-- oxy:deploy-phase=pre
--
-- ADR 0035: a connected account (WhatsApp, Telegram) belongs to exactly one gemie. That gemie answers
-- what arrives on it, and only its turns can see or use it.
--
-- Pre, and only additive: a nullable `agent_id` the image being replaced neither writes nor reads.
-- The foreign key cascades, so deleting a gemie removes its accounts (the delete route first stops
-- their sessions and revokes their tasks: `lib/gemie-accounts.ts`). It is added NOT VALID, so the
-- lock on `agents` lasts an instant; 0142 (post) validates it, backfills every row, the old image's
-- included, and makes `agent_id` NOT NULL. Production held 0 connected accounts when this was
-- written.
ALTER TABLE "connected_accounts" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "connected_accounts_agent_user_idx" ON "connected_accounts" USING btree ("agent_id","oxy_user_id");
