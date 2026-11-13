/**
 * A connected account's turn: the message prepared by the API (its media kept and transcribed),
 * after the stored history resent exactly as it is stored, parts included, so the API's saver
 * appends to it rather than rewriting it.
 */

import { describe, expect, it, vi } from 'vitest';
import type { APIClient } from '../api-client';
import { handleIncomingMessage } from '../chat-handler';

const photo = { type: 'file' as const, file: { file_id: 'f', filename: 'photo.jpg' } };

describe('a connected account’s turn', () => {
  it('answers with what the API prepared, after the stored history as it is', async () => {
    const stored = [
      { role: 'user', content: [{ type: 'text', text: '[Photo]' }, photo] },
      { role: 'assistant', content: 'Nice photo.' },
    ];
    const prepared = [
      { type: 'text' as const, text: '[Voice note, 0:03]' },
      {
        type: 'file' as const,
        file: { file_id: 'v', filename: 'voice.ogg', mime: 'audio/ogg', transcript: 'hola' },
      },
    ];
    const chatCompletion = vi.fn(async () => ({ content: 'Hola.', finishReason: 'stop' }));
    const api = {
      decideInbound: async () => ({ answer: true }),
      prepareAccountMessage: vi.fn(async () => ({ content: prepared })),
      getConversation: async () => ({ messages: stored }),
      requestModel: async () => undefined,
      chatCompletion,
    } as unknown as APIClient;
    const sent: string[] = [];
    const message = { text: '', media: [{ kind: 'voice' as const, durationSeconds: 3 }] };

    await handleIncomingMessage(
      {
        platform: 'whatsapp',
        sessionId: 's1',
        inbound: { chatId: 'c1', chatKind: 'direct', mentionsAccount: false },
        readMessage: async () => message,
        sendResponse: async (text) => {
          sent.push(text);
        },
      },
      api,
    );

    expect(api.prepareAccountMessage).toHaveBeenCalledWith(
      { kind: 'account', sessionId: 's1' },
      { chatId: 'c1', message },
    );
    const [, messages] = chatCompletion.mock.calls[0] as unknown as [unknown, unknown[]];
    expect(messages.slice(1)).toEqual([...stored, { role: 'user', content: prepared }]);
    expect(sent).toEqual(['Hola.']);
  });

  it('reads nothing of a message its gemie does not answer', async () => {
    const readMessage = vi.fn();
    await handleIncomingMessage(
      {
        platform: 'whatsapp',
        sessionId: 's1',
        inbound: { chatId: 'c1', chatKind: 'group', mentionsAccount: false },
        readMessage,
        sendResponse: async () => {},
      },
      { decideInbound: async () => ({ answer: false }) } as unknown as APIClient,
    );
    expect(readMessage).not.toHaveBeenCalled();
  });
});
