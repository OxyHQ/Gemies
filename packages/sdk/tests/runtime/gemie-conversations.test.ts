import { describe, expect, it } from 'vitest';
import {
  type GemieConversationLive,
  foldGemieConversationEvent,
  gemieConversationOf,
} from '../../src/runtime/gemie-conversations';
import type { RoomEvent } from '../../src/runtime/room-events';

/**
 * A gemie writing to another (ADR 0041), as the person's chat draws it: the call names the
 * conversation it wrote in, and the conversation's own events say whether they are still talking.
 */

const PEPE = { id: 'pepe', name: 'Pepe', handle: 'pepe' };
const LUMEN = { id: 'lumen', name: 'Lumen', handle: 'lumen' };

describe('the call', () => {
  it('names the conversation, the chain and both gemies once it has a result', () => {
    expect(
      gemieConversationOf({
        toolCallId: 't',
        toolName: 'sendMessage',
        state: 'result',
        args: { to: 'lumen', text: 'hi' },
        result: { status: 'sent', conversationId: 'between', chainId: 'k', from: PEPE, to: LUMEN },
      }),
    ).toEqual({
      conversationId: 'between',
      chainId: 'k',
      from: PEPE,
      to: LUMEN,
      writing: false,
      error: null,
    });
  });

  it('is still writing while it runs, and names nothing it was refused', () => {
    expect(
      gemieConversationOf({ toolCallId: 't', toolName: 'sendMessage', state: 'call', args: {} }),
    ).toMatchObject({ writing: true, conversationId: null, from: null });
    expect(
      gemieConversationOf({
        toolCallId: 't',
        toolName: 'sendMessage',
        state: 'result',
        result: { error: 'Gemie not found' },
      }),
    ).toMatchObject({ error: 'Gemie not found', conversationId: null });
  });

  it('is not any other call', () => {
    expect(
      gemieConversationOf({ toolCallId: 't', toolName: 'webSearch', state: 'result' }),
    ).toBeNull();
  });
});

describe('following the conversation live', () => {
  const quiet: GemieConversationLive = { talking: false, speaking: null, lastLine: null };
  const on = (event: string, data: Record<string, unknown>, chainId = 'k'): RoomEvent => ({
    conversationId: 'between',
    chainId,
    event,
    data,
  });
  const fold = (events: RoomEvent[], from = quiet) =>
    events.reduce((live, event) => foldGemieConversationEvent(live, event, 'between', 'k'), from);

  it('is talking from a gemie starting to write until the chain is idle', () => {
    const writing = fold([on('alia.agent_start', { consultId: 'r', agent: LUMEN })]);
    expect(writing).toEqual({ talking: true, speaking: LUMEN, lastLine: null });
    const said = fold(
      [
        on('alia.agent_end', { consultId: 'r', status: 'completed' }),
        on('group.message', { message: { id: 'r', content: ' It fits two. ' } }),
      ],
      writing,
    );
    expect(said).toEqual({ talking: true, speaking: null, lastLine: 'It fits two.' });
    expect(fold([on('group.idle', { reason: 'done' })], said)).toEqual({
      talking: false,
      speaking: null,
      lastLine: 'It fits two.',
    });
  });

  it('ignores another chain of the same two gemies, and another conversation', () => {
    expect(fold([on('alia.agent_start', { agent: LUMEN }, 'other')])).toBe(quiet);
    expect(
      foldGemieConversationEvent(
        quiet,
        { conversationId: 'elsewhere', event: 'group.idle', data: {} },
        'between',
        'k',
      ),
    ).toBe(quiet);
  });
});
