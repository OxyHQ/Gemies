-- oxy:deploy-phase=pre
--
-- ADR 0036: a gemie's identity is an Oxy `bot` account (`identity = 'oxy'`, every row today) or its
-- own, kept on the row (`identity = 'local'`): a name (`local_name`) and a colour (`local_color`,
-- the vocabulary of an account's `User.color`) beside the character every gemie already keeps here.
-- An external agent (ADR 0030) is `local`: a CLI paired from its owner's computer gets no Oxy account.
--
-- Additive: the image being replaced reads none of these columns and writes `oxy_account_id` on every
-- row it creates, so dropping its NOT NULL changes nothing for it. Every existing row is `oxy` (the
-- default) and satisfies both CHECKs; 0149 (post) turns the existing external agents into `local`
-- ones once that image has drained, and 0150 validates the CHECKs.
--
-- ## LOCKS
--
-- ADD COLUMN with a constant DEFAULT (or none) and DROP NOT NULL are catalogue changes (no rewrite, no
-- scan). The CHECKs are added NOT VALID, which scans nothing, and still hold every row written from
-- now on; 0150 validates them.
ALTER TABLE "agents" ADD COLUMN "identity" text DEFAULT 'oxy' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "local_name" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "local_color" text;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "oxy_account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_identity_source_check" CHECK ("agents"."identity" in ('oxy', 'local')) NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_identity_check" CHECK (("agents"."identity" = 'oxy' and "agents"."oxy_account_id" is not null and "agents"."local_name" is null and "agents"."local_color" is null) or ("agents"."identity" = 'local' and "agents"."oxy_account_id" is null and "agents"."local_name" is not null and "agents"."local_color" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_local_identity_check" CHECK ("agents"."identity" = 'oxy' or ("agents"."is_published" = false and "agents"."access" = 'private' and "agents"."mailbox" = false and "agents"."reach" = 'grants' and "agents"."owner_oxy_account_id" is not null)) NOT VALID;
