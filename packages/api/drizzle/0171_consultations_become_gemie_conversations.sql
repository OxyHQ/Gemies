-- oxy:deploy-phase=post
--
-- ADR 0041: a consultation stops being a tool call in the person's chat and becomes what it always
-- was, a conversation between two gemies. Every consultation stored the old way moves into the
-- conversation the two gemies now have for that person:
--
--  - a `consultAgent` call that was answered becomes the consulting gemie's message (its `task`)
--    and the consulted one's answer, at the time it happened, in that conversation;
--  - an answer the old saver also stored in the person's chat (`<reply id>-agent-<n>`, attributed by
--    its own identity or by the n-th call of its turn) is that same answer, and leaves the chat; an
--    answer whose call was not kept still moves, with no question before it;
--  - the call itself becomes a `sendMessage` call, so the chat draws the card that opens the
--    conversation. A call that failed keeps its error under the new name and opens nothing.
--
-- `post`: the image that wrote consultations has stopped serving, so none is written after this.
-- Idempotent: it reads only what it converts, and converts it away. An answer that names no gemie
-- at all stays where it is (it is drawn as the chat's own reply, as it was).
--
-- Production held 13 calls and 18 answers of one person when this was written.

CREATE TEMP TABLE consultation_exchanges (
  seq serial,
  oxy_user_id text NOT NULL,
  origin text NOT NULL,
  at timestamptz NOT NULL,
  -- Where it was: the call (message row and position) and/or the stored answer (message row).
  call_message_id text,
  call_ord bigint,
  answer_message_id text,
  consulter text NOT NULL,
  consulter_name text NOT NULL,
  consulter_color text,
  consulter_character jsonb,
  consulter_handle text,
  consultee text NOT NULL,
  consultee_name text NOT NULL,
  consultee_color text,
  consultee_character jsonb,
  consultee_handle text,
  task text,
  answer text,
  conversation_id text
) ON COMMIT DROP;
--> statement-breakpoint

-- The answered calls, each with the answer stored for it when there is one.
INSERT INTO consultation_exchanges (
  oxy_user_id, origin, at, call_message_id, call_ord, answer_message_id,
  consulter, consulter_name, consulter_color, consulter_character, consulter_handle,
  consultee, consultee_name, consultee_color, consultee_character, consultee_handle, task, answer
)
SELECT
  m.oxy_user_id,
  m.conversation_id,
  m.created_at,
  m.id,
  call.ord,
  stored.id,
  coalesce(m.agent_info_id, c.agent_id),
  coalesce(m.agent_info_name, CASE WHEN c.agent_id = '01a1cf00-cecf-7a24-868b-42b452105a6f' THEN 'Alia' END, lead.local_name, 'Gemie'),
  m.agent_info_color,
  m.agent_info_character,
  coalesce(m.agent_info_handle, CASE WHEN c.agent_id = '01a1cf00-cecf-7a24-868b-42b452105a6f' THEN 'alia' END),
  call.value -> 'result' ->> 'agentId',
  coalesce(call.value -> 'result' ->> 'agentName', 'Gemie'),
  call.value -> 'result' ->> 'agentColor',
  CASE WHEN jsonb_typeof(call.value -> 'result' -> 'agentCharacter') = 'object' THEN call.value -> 'result' -> 'agentCharacter' END,
  call.value -> 'result' ->> 'agentHandle',
  nullif(call.value -> 'args' ->> 'task', ''),
  coalesce(stored.content #>> '{}', call.value -> 'result' ->> 'response')
FROM messages m
JOIN conversations c ON c.oxy_user_id = m.oxy_user_id AND c.conversation_id = m.conversation_id
LEFT JOIN agents lead ON lead.id = coalesce(m.agent_info_id, c.agent_id)
CROSS JOIN LATERAL jsonb_array_elements(m.tool_invocations) WITH ORDINALITY AS call(value, ord)
LEFT JOIN LATERAL (
  -- The n-th answered call of a turn was stored as `<reply id>-agent-<n>`.
  SELECT a.id, a.content
  FROM messages a
  WHERE a.oxy_user_id = m.oxy_user_id
    AND a.conversation_id = m.conversation_id
    AND m.client_message_id IS NOT NULL
    AND a.client_message_id = m.client_message_id || '-agent-' || (
      SELECT count(*) FROM jsonb_array_elements(m.tool_invocations) WITH ORDINALITY AS earlier(value, ord)
      WHERE earlier.ord < call.ord
        AND earlier.value ->> 'toolName' = 'consultAgent'
        AND earlier.value ->> 'state' = 'result'
        AND NOT (earlier.value -> 'result' ? 'error')
    )
  LIMIT 1
) stored ON true
WHERE jsonb_typeof(m.tool_invocations) = 'array'
  AND call.value ->> 'toolName' = 'consultAgent'
  AND call.value ->> 'state' = 'result'
  AND NOT (call.value -> 'result' ? 'error')
  AND call.value -> 'result' ->> 'agentId' IS NOT NULL
  AND call.value -> 'result' ->> 'agentId' <> coalesce(m.agent_info_id, c.agent_id);
--> statement-breakpoint

-- Answers the chat kept whose call was not kept (or failed): they move too, with no question.
INSERT INTO consultation_exchanges (
  oxy_user_id, origin, at, answer_message_id,
  consulter, consulter_name, consulter_color, consulter_character, consulter_handle,
  consultee, consultee_name, consultee_color, consultee_character, consultee_handle, answer
)
SELECT
  a.oxy_user_id,
  a.conversation_id,
  a.created_at,
  a.id,
  c.agent_id,
  CASE WHEN c.agent_id = '01a1cf00-cecf-7a24-868b-42b452105a6f' THEN 'Alia' ELSE coalesce(lead.local_name, 'Gemie') END,
  NULL,
  NULL,
  CASE WHEN c.agent_id = '01a1cf00-cecf-7a24-868b-42b452105a6f' THEN 'alia' END,
  a.agent_info_id,
  coalesce(a.agent_info_name, 'Gemie'),
  a.agent_info_color,
  a.agent_info_character,
  a.agent_info_handle,
  a.content #>> '{}'
FROM messages a
JOIN conversations c ON c.oxy_user_id = a.oxy_user_id AND c.conversation_id = a.conversation_id
LEFT JOIN agents lead ON lead.id = c.agent_id
WHERE a.client_message_id ~ '-agent-[0-9]+$'
  AND a.role = 'assistant'
  AND a.agent_info_id IS NOT NULL
  AND a.agent_info_id <> c.agent_id
  AND NOT EXISTS (SELECT 1 FROM consultation_exchanges x WHERE x.answer_message_id = a.id);
--> statement-breakpoint

-- One conversation per person and pair: the one they have, or a new one.
DO $$
DECLARE
  x record;
  conversation text;
  next_seq integer;
  first_id text;
  second_id text;
BEGIN
  FOR x IN SELECT * FROM consultation_exchanges ORDER BY at, seq LOOP
    first_id := least(x.consulter, x.consultee);
    second_id := greatest(x.consulter, x.consultee);
    SELECT g.conversation_id INTO conversation
    FROM gemie_conversations g
    WHERE g.oxy_user_id = x.oxy_user_id AND g.first_agent_id = first_id AND g.second_agent_id = second_id;
    IF conversation IS NULL THEN
      conversation := gen_random_uuid()::text;
      INSERT INTO conversations (id, oxy_user_id, conversation_id, title, source, agent_id, created_at, updated_at)
      VALUES (gen_random_uuid()::text, x.oxy_user_id, conversation, left(x.consulter_name || ' · ' || x.consultee_name, 100),
              'app', '01a1cf00-cecf-7a24-868b-42b452105a6f', x.at, x.at);
      INSERT INTO conversation_members (id, oxy_user_id, conversation_id, agent_id, position)
      VALUES (gen_random_uuid()::text, x.oxy_user_id, conversation, x.consulter, 0),
             (gen_random_uuid()::text, x.oxy_user_id, conversation, x.consultee, 1);
      INSERT INTO gemie_conversations (id, oxy_user_id, conversation_id, first_agent_id, second_agent_id, created_at)
      VALUES (gen_random_uuid()::text, x.oxy_user_id, conversation, first_id, second_id, x.at);
    END IF;

    SELECT coalesce(max(m.seq) + 1, 0) INTO next_seq
    FROM messages m WHERE m.oxy_user_id = x.oxy_user_id AND m.conversation_id = conversation;
    IF x.task IS NOT NULL THEN
      INSERT INTO messages (id, conversation_id, oxy_user_id, client_message_id, role, content, seq, created_at,
                            agent_info_id, agent_info_name, agent_info_color, agent_info_character, agent_info_handle)
      VALUES (gen_random_uuid()::text, conversation, x.oxy_user_id, 'gemie-message-migrated-' || x.seq || '-0',
              'assistant', to_jsonb(x.task), next_seq, x.at,
              x.consulter, x.consulter_name, x.consulter_color, x.consulter_character, coalesce(x.consulter_handle, ''));
      next_seq := next_seq + 1;
    END IF;
    IF coalesce(x.answer, '') <> '' THEN
      INSERT INTO messages (id, conversation_id, oxy_user_id, client_message_id, role, content, seq, created_at,
                            agent_info_id, agent_info_name, agent_info_color, agent_info_character, agent_info_handle)
      VALUES (gen_random_uuid()::text, conversation, x.oxy_user_id, 'group-reply-gemies-migrated-' || x.seq || '-1',
              'assistant', to_jsonb(x.answer), next_seq, x.at + interval '1 millisecond',
              x.consultee, x.consultee_name, x.consultee_color, x.consultee_character, coalesce(x.consultee_handle, ''));
    END IF;
    UPDATE conversations
    SET last_message = left(coalesce(nullif(x.answer, ''), x.task, ''), 100),
        updated_at = greatest(updated_at, x.at)
    WHERE oxy_user_id = x.oxy_user_id AND conversation_id = conversation;
    UPDATE consultation_exchanges SET conversation_id = conversation WHERE seq = x.seq;
  END LOOP;
END $$;
--> statement-breakpoint

-- Every `consultAgent` call becomes a `sendMessage` call: the card that opens the conversation, or,
-- for a call that failed or moved nothing, its error under the new name.
UPDATE messages m
SET tool_invocations = (
  SELECT jsonb_agg(
    CASE
      WHEN call.value ->> 'toolName' <> 'consultAgent' THEN call.value
      ELSE jsonb_strip_nulls(jsonb_build_object(
        'toolCallId', call.value -> 'toolCallId',
        'toolName', 'sendMessage',
        'state', call.value -> 'state',
        'args', jsonb_build_object(
          'to', call.value -> 'args' -> 'agentId',
          'text', call.value -> 'args' -> 'task'
        ),
        'result', CASE
          WHEN x.conversation_id IS NOT NULL THEN jsonb_build_object(
            'status', 'sent',
            'conversationId', x.conversation_id,
            'from', jsonb_build_object('id', x.consulter, 'name', x.consulter_name, 'handle', coalesce(x.consulter_handle, ''),
                                       'color', x.consulter_color, 'character', x.consulter_character),
            'to', jsonb_build_object('id', x.consultee, 'name', x.consultee_name, 'handle', coalesce(x.consultee_handle, ''),
                                     'color', x.consultee_color, 'character', x.consultee_character)
          )
          WHEN call.value ? 'result' THEN jsonb_build_object(
            'error', coalesce(call.value -> 'result' ->> 'error', 'That gemie could not be written to')
          )
        END
      ))
    END
    ORDER BY call.ord
  )
  FROM jsonb_array_elements(m.tool_invocations) WITH ORDINALITY AS call(value, ord)
  LEFT JOIN consultation_exchanges x ON x.call_message_id = m.id AND x.call_ord = call.ord
)
WHERE jsonb_typeof(m.tool_invocations) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(m.tool_invocations) AS call(value)
    WHERE call.value ->> 'toolName' = 'consultAgent'
  );
--> statement-breakpoint

-- The answers that moved leave the person's chat.
DELETE FROM messages m
USING consultation_exchanges x
WHERE x.answer_message_id = m.id AND x.conversation_id IS NOT NULL;
