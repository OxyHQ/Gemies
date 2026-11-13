-- oxy:deploy-phase=post
--
-- ADR 0035: removing a connected account now deletes its session row, and its chats and messages
-- with it (the foreign keys cascade). Sessions removed before that were only marked `logged-out`
-- and kept everything they had synced, with no account left to reach them: production held two
-- such WhatsApp sessions, from links removed before they were scanned. A `logged-out` session is
-- never restored, so forgetting them loses nothing anyone can use. Post, so the image being
-- replaced is not mid-way through marking one.
DELETE FROM "whatsapp_sessions" WHERE "status" = 'logged-out';--> statement-breakpoint
DELETE FROM "telegram_sessions" WHERE "status" = 'logged-out';
