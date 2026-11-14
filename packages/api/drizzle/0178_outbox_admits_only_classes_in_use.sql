-- oxy:deploy-phase=pre
--
-- The reference outbox admits only the Oxy file entity classes Alia uses. Migration 0176 retired
-- generated podcasts and enqueued, as `absent` intents, the release of each cover reference Gemies
-- held under `show_series`; the outbox CHECK kept admitting that class only so the image that
-- replaced its last writer could deliver those releases. It has: production, read-only on
-- 2026-11-14, holds 0 `oxy_file_reference_sync` rows with `entity_type = 'show_series'`, and in
-- Oxy the cover file is referenced only by Syra's `podcast` now.
--
-- `pre`, not `post`: the narrowing refuses a write only of `show_series`, and no running image
-- performs one. The image serving today (0176's) has no writer of that class — only the outbox
-- worker could touch such a row, and there is none — and the image this rollout ships no longer
-- names it at all. Nothing the previous image does breaks, so nothing waits for its tasks to drain.
-- The outbox is small (only work still owed), so validating the CHECK on ADD is a short scan.
ALTER TABLE "oxy_file_reference_sync" DROP CONSTRAINT "oxy_file_reference_sync_entity_type_check";--> statement-breakpoint
ALTER TABLE "oxy_file_reference_sync" ADD CONSTRAINT "oxy_file_reference_sync_entity_type_check" CHECK ("oxy_file_reference_sync"."entity_type" in ('library_file', 'speech_clip', 'skill_file'));
