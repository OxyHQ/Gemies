-- oxy:deploy-phase=post
--
-- A message of a conversation is its person's or its gemie's: `messages_role_check` no longer
-- admits `system` (`domain/conversation.ts` `MESSAGE_ROLES`). 0172 removed the rows it held.
--
-- POST: the image being replaced still stores a system message until it has drained.
--
-- ## LOCKS
--
-- NOT VALID: adding the CHECK takes ACCESS EXCLUSIVE on `messages` only for the catalogue change,
-- without scanning it; 0174 validates it under SHARE UPDATE EXCLUSIVE, which blocks no read or
-- write.
ALTER TABLE "messages" DROP CONSTRAINT "messages_role_check";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('user', 'assistant')) NOT VALID;
