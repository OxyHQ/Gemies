-- oxy:deploy-phase=post
--
-- A gemie's colour is its Oxy account's `User.color` and nothing else: its character keeps its shape
-- and features and loses its paint (`color`, a named paint, and `bodyColor`, a free hex). Post phase,
-- so the paints go once the previous image, which still read and wrote them, has drained; the image
-- this rollout ships ignores a stored paint (clients paint a character in the account's colour) and
-- refuses one on write (`lib/agent-character.ts`).
--
-- Every gemie account already had a colour of its own (Oxy gives every account one when it is
-- created), so no paint is moved to an account: when this was written, 11 of 11 gemies with an Oxy
-- account had one, and Alia's account does not exist yet. The messages' snapshot of who said them
-- (`agent_info_character`) loses its paint the same way; the colour they are drawn in is
-- `agent_info_color`, the account's. Production held 12 painted agents and 17 painted messages.
UPDATE "agents" SET "character" = "character" - 'color' - 'bodyColor' WHERE "character" ?| array['color', 'bodyColor'];--> statement-breakpoint
UPDATE "messages" SET "agent_info_character" = "agent_info_character" - 'color' - 'bodyColor' WHERE "agent_info_character" ?| array['color', 'bodyColor'];
