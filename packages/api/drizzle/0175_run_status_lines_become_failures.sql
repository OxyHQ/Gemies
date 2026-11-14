-- oxy:deploy-phase=post
--
-- A requested run's status line, delivered as the gemie's message before a run wrote its answer or
-- a typed failure (`lib/agent/runner.ts`, `runResultMessage`): "Token budget exhausted. Partial
-- progress was made." in Eusebio's Telegram chat (2026-11-14), one row in production when this was
-- written. It becomes the typed failure the app draws in the reader's language. Only a run's result
-- (`agent-push-result-…`) whose whole text is one of the runner's own lines is touched.
--
-- POST: the app reads the typed failure from this release's SDK on; the image being replaced
-- still delivers the old lines until it has drained.
UPDATE "messages"
SET "content" = '[{"type": "failure", "code": "task_unfinished"}]'::jsonb
WHERE "client_message_id" LIKE 'agent-push-result-%'
  AND jsonb_typeof("content") = 'string'
  AND (
    "content" #>> '{}' IN (
      'Token budget exhausted. Partial progress was made.',
      'Step limit reached. Partial progress was made.'
    )
    OR "content" #>> '{}' LIKE 'Time limit reached. Partial progress:%'
    OR "content" #>> '{}' LIKE 'Task stopped after 5 consecutive errors.%'
    OR "content" #>> '{}' LIKE 'I couldn''t finish the scheduled task.%'
    OR "content" #>> '{}' LIKE 'I couldn''t finish this task.%'
  );
