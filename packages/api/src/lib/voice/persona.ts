/**
 * What the voice of a call holds: a persona and the conversation so far
 * (ADR 0041 §3). Who speaks (the identity guard's), how it sounds and in which language, and the
 * recent messages as text so it knows what was said before the call. Never the
 * gemie's instructions or tools: every turn is answered by the chat route
 * (`delegated-turn.ts`), with the same prompt, tools and memory as a typed one.
 */

import { realtimeSessionConfigSchema } from '@kaana.ai/contracts';
import { listMessages, toStoredMessage } from '../../db/chat/messageRepository.js';
import { getDb } from '../../db/index.js';
import type { MessageContent, ToolInvocation } from '../../domain/conversation.js';
import { agentPromptName, type HydratedAgent } from '../agent-identity.js';
import { buildVoiceIdentity } from '../identity-guard.js';

/** A stored message of the conversation, as a delegated turn sends it and the persona reads it. */
export interface HistoryMessage {
  /** The id it is stored under, sent back so the chat route appends rather than rewrites. */
  readonly id: string;
  readonly role: string;
  readonly content: MessageContent;
  readonly toolInvocations?: ToolInvocation[];
}

/** The conversation's stored messages, oldest first. */
export async function loadConversationHistory(
  oxyUserId: string,
  conversationId: string,
): Promise<HistoryMessage[]> {
  const rows = await listMessages(getDb(), oxyUserId, conversationId);
  return rows.map((row) => {
    const message = toStoredMessage(row);
    return {
      id: message.id ?? row.id,
      role: message.role,
      content: message.content,
      ...(message.toolInvocations ? { toolInvocations: message.toolInvocations } : {}),
    };
  });
}

/** The plain text of a message, whatever its parts. */
export function textOf(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
        ? part.text
        : '',
    )
    .filter((text) => text !== '')
    .join('\n');
}

/** The contract's own bound on a session's instructions, read from its schema. */
const MAX_INSTRUCTIONS =
  realtimeSessionConfigSchema.shape.instructions.unwrap().maxLength ?? Number.POSITIVE_INFINITY;

/** The most history the persona carries. */
const HISTORY_CHARS = 12_000;
/** One message's share, so a single long answer cannot crowd out the rest. */
const HISTORY_MESSAGE_CHARS = 1_500;

/** The recent messages that fit `budget` characters, oldest first, as `Person:`/`You:` lines. */
export function historyLines(history: readonly HistoryMessage[], budget: number): string[] {
  const lines: string[] = [];
  let used = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    let text = textOf(message.content).replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    if (text.length > HISTORY_MESSAGE_CHARS) text = `${text.slice(0, HISTORY_MESSAGE_CHARS)}…`;
    const line = `${message.role === 'user' ? 'Person' : 'You'}: ${text}`;
    if (used + line.length + 1 > budget) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines;
}

/**
 * The `instructions` of a call's `live` session: the gemie's name, a speaking
 * style, the person's language and the recent conversation, within the
 * contract's bound (the history is what shrinks).
 */
export function voicePersona(input: {
  readonly gemie: HydratedAgent;
  readonly language: string;
  readonly history: readonly HistoryMessage[];
}): string {
  const head = [
    // Who speaks is the identity guard's to say, as in a typed turn: the person's own assistant
    // is Alia, any other gemie its own name (`system-prompt-builder.ts`).
    buildVoiceIdentity(
      input.gemie.reach === 'person' ? {} : { agentName: agentPromptName(input.gemie) },
    ),
    '',
    '## How you sound',
    'You are talking with the person in a voice call.',
    'Sound natural and warm: conversational rhythm, clear diction, energy that fits the moment.',
    'Keep what you say short and easy to follow by ear.',
    '',
    '## Language',
    `The person is speaking ${input.language}. Speak that language unless they switch to another.`,
  ].join('\n');
  let budget = Math.min(HISTORY_CHARS, MAX_INSTRUCTIONS - head.length - 200);
  for (;;) {
    const lines = historyLines(input.history, Math.max(0, budget));
    const text =
      lines.length === 0
        ? head
        : [
            head,
            '',
            '## The conversation so far',
            'This call continues the conversation below (oldest first). Do not repeat it.',
            ...lines,
          ].join('\n');
    if (text.length <= MAX_INSTRUCTIONS || lines.length === 0) return text;
    budget = lines.join('\n').length - (text.length - MAX_INSTRUCTIONS) - 1;
  }
}
