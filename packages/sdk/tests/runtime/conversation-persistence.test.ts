import { type PersistBatch, type Persister, Store, withStore } from '@oxy.so/bloom-data';
import { describe, expect, it } from 'vitest';
import {
  ConversationMessages,
  MAX_PERSISTED_BYTES,
  MAX_PERSISTED_CONVERSATIONS,
  MAX_PERSISTED_MESSAGES,
  messagesRecord,
  trimConversationMessages,
} from '../../src/runtime/data/conversations';
import type { Message } from '../../src/runtime/types';

/**
 * How much of a conversation survives a restart (the bound the app's persisted cache had): the
 * messages of the 20 conversations written last, each its last 40 finished messages, text only,
 * at most 150 KB. Memory keeps everything; only the durable copy is bounded.
 */

const message = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: 'user',
  content: id,
  ...extra,
});
const record = (messages: Message[]) =>
  messagesRecord({ id: 'c1', title: 'c1', createdAt: '', updatedAt: '', messages });

describe('what the durable copy keeps of a conversation', () => {
  it('never a turn still streaming or not yet stored, so a restart shows no half-written reply', () => {
    const trimmed = trimConversationMessages(
      record([
        message('done'),
        message('streaming', { role: 'assistant', isStreaming: true }),
        message('unsaved', { unsaved: true }),
      ]),
    );
    expect(trimmed.messages.map((m) => m.id)).toEqual(['done']);
  });

  it('its last 40 messages', () => {
    const many = Array.from({ length: 50 }, (_, i) => message(`m${i}`));
    const trimmed = trimConversationMessages(record(many));
    expect(trimmed.messages).toHaveLength(MAX_PERSISTED_MESSAGES);
    expect(trimmed.messages[0]?.id).toBe('m10');
    expect(trimmed.messages.at(-1)?.id).toBe('m49');
  });

  it('text only: an image part is left to the next read', () => {
    const [kept] = trimConversationMessages(
      record([
        message('pic', {
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        }),
      ]),
    ).messages;
    expect(kept?.content).toEqual([{ type: 'text', text: 'what is this' }]);
  });

  it('at most 150 KB, dropping the oldest messages first', () => {
    const big = Array.from({ length: 30 }, (_, i) =>
      message(`m${i}`, { content: 'x'.repeat(10_000) }),
    );
    const trimmed = trimConversationMessages(record(big));
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(MAX_PERSISTED_BYTES);
    expect(trimmed.messages.at(-1)?.id).toBe('m29');
    expect(trimmed.messages.length).toBeLessThan(30);
  });
});

/** A durable copy that records how it was opened and what was written to it. */
function recordingPersister() {
  const opened: Parameters<Persister['open']>[0][] = [];
  const written: PersistBatch[] = [];
  const persister: Persister = {
    open: async (options) => {
      opened.push(options);
    },
    readRecords: async () => [],
    readList: async () => null,
    write: async (batch) => {
      written.push(batch);
    },
    close: async () => undefined,
    destroy: async () => undefined,
  };
  return { persister, opened, written };
}

describe("the account's durable copy", () => {
  it('keeps the messages of the 20 conversations written last, each trimmed; memory keeps all', async () => {
    const { persister, opened, written } = recordingPersister();
    const store = new Store({ persister });
    withStore(store, () =>
      ConversationMessages.put(
        record([message('done'), message('streaming', { isStreaming: true })]),
      ),
    );
    await store.flush();

    expect(opened[0]?.limits?.['gemies.conversation-messages']).toBe(MAX_PERSISTED_CONVERSATIONS);
    const rows = written.flatMap((batch) => batch.records);
    const stored = rows.find((row) => row.type === 'gemies.conversation-messages');
    expect(JSON.parse(stored?.json ?? '{}').messages.map((m: Message) => m.id)).toEqual(['done']);
    // The row is stored on its own, without messages.
    const row = rows.find((r) => r.type === 'gemies.conversation');
    expect(JSON.parse(row?.json ?? '{}')).not.toHaveProperty('messages');
    expect(withStore(store, () => ConversationMessages.get('c1'))?.messages).toHaveLength(2);
    await store.close();
  });
});
