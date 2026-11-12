-- oxy:deploy-phase=pre
--
-- ADR 0034 §2: Alia is one official, global gemie — an `agents` row everybody uses. This seeds the
-- row; it rewrites no other row (0136, post, does).
--
-- ## The row
--
-- Matched by its fixed id (`ALIA_GEMIE_ID` in `domain/alia-gemie.ts`), never by name or handle, and
-- inserted only if absent, so running this twice changes nothing. What made Alia different is the
-- configuration 0134 added: her memory is Nilo's, she reaches whatever the person has, she has no
-- mailbox, and her tasks run under standing authority on `alia-tasks`. She has no `computer` (nor its
-- `browser`) grant: no machine.
--
-- `oxy_account_id` is NOT her Oxy account yet. Oxy reserves the username `alia` and models her as the
-- actor `{ type: 'alia', ownerAccountId }`, which its schema requires to have no account; it creates
-- the Alia gemie's account in its own contract (ADR 0034 phase 2). Until a later migration writes it
-- (by this id), the row holds a value Oxy resolves to nobody (`ALIA_PENDING_OXY_ACCOUNT_ID`); nothing
-- sends it to Oxy as authority, because Alia's Oxy calls go through the person lane
-- (`lib/gemie-oxy-actor.ts`) and she has no mailbox. `owner_oxy_account_id` stays null for the same
-- reason.
--
-- Public (anybody may use her: she is everybody's default gemie, and reaching her asks Oxy nothing)
-- but NOT listed yet: a catalogue card with no name, handle or colour would be a visible regression.
-- The migration that writes her account also sets `is_published`, as ADR 0034 §2 asks.
--
-- PRE: the image being replaced never reads this row (nothing names her id there), and the image
-- being rolled out needs it before its first turn.
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_memory_store_check";--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_reach_check";--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_task_authority_check";--> statement-breakpoint
INSERT INTO "agents" (
  "id",
  "oxy_account_id",
  "owner_oxy_account_id",
  "character",
  "tagline",
  "description",
  "author_oxy_user_id",
  "category",
  "capability_grants",
  "is_published",
  "access",
  "status",
  "memory_store",
  "reach",
  "mailbox",
  "task_authority"
) VALUES (
  '01a1cf00-cecf-7a24-868b-42b452105a6f',
  'pending-oxy-account:alia',
  NULL,
  '{"preset":"blue_beret","accessory":"none","color":"orchid"}'::jsonb,
  'Oxy''s assistant, the same one for everybody.',
  'Alia answers, remembers you in Nilo, runs your tasks and works in your Oxy apps for you. She can ask any other gemie you can open.',
  'pending-oxy-account:alia',
  'assistant',
  ARRAY['web', 'artifacts', 'memory', 'messaging', 'automation', 'delegation', 'agent']::text[],
  false,
  'public',
  'active',
  'nilo',
  'person',
  false,
  'standing'
) ON CONFLICT ("id") DO NOTHING;
