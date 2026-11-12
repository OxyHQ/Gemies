-- oxy:deploy-phase=pre
--
-- ADR 0034 §2: Alia becomes an `agents` row, and what made her different becomes configuration of a
-- gemie instead of a `null` agent. Four attributes every gemie has (`domain/agent.ts` says what each
-- value decides); the defaults are an ordinary gemie's, so every existing row keeps behaving as it did,
-- and only Alia's row (0135) holds the other values:
--
--   memory_store   'gemie' | 'nilo'      where it remembers the person
--   reach          'grants' | 'person'   what it reaches for the person present
--   mailbox        true | false          whether its own Oxy account is a working account
--   task_authority 'session' | 'standing' how its background work is authorized and run
--
-- Additive: the image being replaced never reads these columns. DDL ONLY: the seed and the backfill
-- are 0135, its own transaction, so no lock on the hot `agents` table is held while rows are written.
--
-- ## LOCKS
--
-- ADD COLUMN with a constant DEFAULT and NOT NULL is a catalogue change on PostgreSQL 11+ (no rewrite,
-- no scan). The CHECKs are added NOT VALID, which scans nothing, and 0135 validates them.
ALTER TABLE "agents" ADD COLUMN "memory_store" text DEFAULT 'gemie' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "reach" text DEFAULT 'grants' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "mailbox" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "task_authority" text DEFAULT 'session' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_memory_store_check" CHECK ("agents"."memory_store" in ('nilo', 'gemie')) NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_reach_check" CHECK ("agents"."reach" in ('person', 'grants')) NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_task_authority_check" CHECK ("agents"."task_authority" in ('standing', 'session')) NOT VALID;
