/**
 * A channel turn's `/alia/chat` stream, read to the end: keep-alive comments hold it open while the
 * turn runs (a JSON answer could not outlast the load balancer's idle timeout), and an error the
 * turn sends after it opened is thrown, never taken for an answer.
 */

import { describe, expect, it } from 'vitest';
import { readChatStream } from '../api-client';

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

describe('a channel turn’s stream', () => {
  it('is the text of its deltas, across keep-alives and split chunks', async () => {
    const frame = delta('Hola, ');
    expect(
      await readChatStream(
        stream(
          ': keep-alive\n\n',
          frame.slice(0, 10),
          frame.slice(10),
          ': keepalive\n\n',
          delta('Nate.'),
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ),
      ),
    ).toEqual({ content: 'Hola, Nate.', finishReason: 'stop' });
  });

  it('throws an error the turn sent after the stream opened', async () => {
    await expect(
      readChatStream(
        stream(
          ': keep-alive\n\n',
          `data: ${JSON.stringify({ error: { message: 'No available route', code: 'no_route' } })}\n\n`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'no_route' });
  });
});
