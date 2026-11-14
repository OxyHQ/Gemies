-- oxy:deploy-phase=post
--
-- Podcast generation leaves Gemies: it belongs to Syra, which writes, voices and publishes episodes
-- itself and is reached from a gemie through the Syra connector (its MCP at api.syra.fm/mcp). The
-- image this rollout ships has no reader or writer of `show_series`, `show_episodes` or
-- `show_preferences` — no `/shows` routes, no show queue or pipeline, no cover storage — and it
-- writes no `show_series` Oxy file reference and no `show_series` reconciliation. Post phase, so the
-- tables go only after the previous image, which still serves `/shows`, has drained.
--
-- Production, counted read-only on 2026-11-14: `show_series` 1, `show_episodes` 2 (both completed,
-- both already published on Syra as podcast 01a038a2-7e9b-737b-b475-855cfcaf2189, owned by the same
-- Oxy user, their audio Syra's own Oxy files), `show_preferences` 0. Nothing is migrated: what a
-- listener has is on Syra already, and Gemies stored no audio.
--
-- ## There is no `pre` half
--
-- Nothing must change before the new image serves. It never touches the three tables, never writes
-- a `show_series` row to `oxy_file_reference_sync` or `oxy_file_reconcile_runs`, and tolerates the
-- wider CHECKs those two tables still have during the rollout. Every statement here undoes something
-- the PREVIOUS image may still do until it stops — serve a series, record its cover's reference,
-- claim the nightly `show_series` reconciliation — so all of it is `post`.
--
-- ## The cover's Oxy file reference is RELEASED, not leaked
--
-- The one series names a cover Gemies drew, an Oxy file Gemies referenced as `show_series`/<id>.
-- Syra holds its OWN reference on that same file (it uses the cover as the podcast's artwork), so
-- the file stays alive for Syra; Gemies' reference must still go, or Oxy would keep the file after
-- Syra let go of it. No trigger records references: the repository writes an intent into the
-- `oxy_file_reference_sync` outbox in the same transaction as the row (`recordFileReferences`), and
-- the outbox worker on every task (`lib/files/oxy-file-sync.ts`) delivers it to
-- `references.remove`. This migration is the last writer of the series, so it writes that intent
-- itself, in the same transaction as the drop:
--
-- 1. An `absent` intent for every series that names a cover file, with the upsert
--    `recordFileReferences` uses (a replaced intent bumps `generation`, so a worker holding the old
--    claim does not delete the new one).
-- 2. Every other `show_series` intent still in the outbox — a pending `present` the previous image
--    wrote during the rollout, a dead letter — becomes a pending `absent` too, so nothing of the
--    class is ever added again and every reference Gemies may hold under it is removed.
-- 3. The `show_series` row of the reconciliation ledger goes, and its CHECK narrows: the nightly
--    reconciliation only covers the classes in use (`OXY_FILE_ENTITY_TYPES`), so it can no longer
--    re-add the cover, and with no inventory left it must not try to.
--
-- The outbox's own CHECK keeps admitting `show_series`
-- (`RELEASE_ONLY_OXY_FILE_ENTITY_TYPES` in `domain/oxy-files.ts`), so the NEW image's worker can
-- claim, retry and complete these releases; no code can write one. Once production's outbox holds
-- no `show_series` row, a later migration narrows that CHECK too and the release-only class goes.
INSERT INTO "oxy_file_reference_sync" ("file_id", "entity_type", "entity_id", "desired")
SELECT "cover_file_id", 'show_series', "id", 'absent' FROM "show_series" WHERE "cover_file_id" IS NOT NULL
ON CONFLICT ("file_id", "entity_type", "entity_id") DO NOTHING;--> statement-breakpoint
UPDATE "oxy_file_reference_sync" SET
	"desired" = 'absent',
	"status" = 'pending',
	"generation" = "generation" + 1,
	"attempts" = 0,
	"available_at" = now(),
	"lease_owner" = NULL,
	"lease_until" = NULL,
	"last_error" = NULL,
	"updated_at" = now()
WHERE "entity_type" = 'show_series' AND ("desired" <> 'absent' OR "status" <> 'pending');--> statement-breakpoint
DELETE FROM "oxy_file_reconcile_runs" WHERE "entity_type" = 'show_series';--> statement-breakpoint
ALTER TABLE "show_episodes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "show_preferences" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "show_series" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "show_episodes" CASCADE;--> statement-breakpoint
DROP TABLE "show_preferences" CASCADE;--> statement-breakpoint
DROP TABLE "show_series" CASCADE;--> statement-breakpoint
ALTER TABLE "oxy_file_reconcile_runs" DROP CONSTRAINT "oxy_file_reconcile_runs_entity_type_check";--> statement-breakpoint
ALTER TABLE "oxy_file_reconcile_runs" ADD CONSTRAINT "oxy_file_reconcile_runs_entity_type_check" CHECK ("oxy_file_reconcile_runs"."entity_type" in ('library_file', 'speech_clip', 'skill_file'));
