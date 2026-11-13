-- oxy:deploy-phase=pre
--
-- ADR 0035, amended: a connected account (WhatsApp, Telegram Business) is the PERSON's, connected
-- once in Settings, and the person grants it to the gemies that may use it, one of which answers it.
--
-- Pre, and only additive for the image being replaced:
--  1. `connected_account_grants`, which that image neither reads nor writes. Its foreign key to
--     `agents` cascades, so deleting a gemie removes its grants; the table is new and empty, so the
--     lock on `agents` lasts an instant.
--  2. `connected_accounts.agent_id` stops being NOT NULL: the new image never writes it, and the old
--     one still does.
--  3. Every account the old image linked becomes its person's, granted to the gemie it belonged to,
--     which answers it as it did. 0157 (post) repeats this for accounts the old image links while it
--     drains, then drops `agent_id`.
--
-- Production held 0 connected accounts when this was written.
CREATE TABLE "connected_account_grants" (
	"account_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"answers" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "connected_account_grants_account_id_agent_id_pk" PRIMARY KEY("account_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "connected_accounts" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_account_grants" ADD CONSTRAINT "connected_account_grants_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_account_grants" ADD CONSTRAINT "connected_account_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connected_account_grants_agent_id_idx" ON "connected_account_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connected_account_grants_one_answering_idx" ON "connected_account_grants" USING btree ("account_id") WHERE "connected_account_grants"."answers";--> statement-breakpoint
INSERT INTO "connected_account_grants" ("account_id", "agent_id", "answers")
SELECT "id", "agent_id", true FROM "connected_accounts" WHERE "agent_id" IS NOT NULL
ON CONFLICT DO NOTHING;
