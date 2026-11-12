-- oxy:deploy-phase=post
--
-- Every conversation belongs to a gemie (ADR 0034 §1), and since 0136 every row names one. The first
-- of three steps to `conversations.agent_id NOT NULL` without scanning the hot table under ACCESS
-- EXCLUSIVE: this CHECK is added NOT VALID (instant, it scans nothing), 0138 validates it under SHARE
-- UPDATE EXCLUSIVE, and 0139 sets NOT NULL, which PostgreSQL 12+ proves from the valid CHECK without a
-- scan, and drops the CHECK.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_present" CHECK ("conversations"."agent_id" IS NOT NULL) NOT VALID;
