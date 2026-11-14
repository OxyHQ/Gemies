/**
 * A turn's attachments, as the thread draws them: a channel's sticker as a sticker, a voice note as
 * a voice message with its transcript, a document as a file chip, and a photo sent inline as before.
 * A file is the person's private Oxy file, drawn from the URL Oxy answers the signed-in caller.
 */

import type React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => (name: string) => async () => {
  const ReactModule = await import('react');
  return ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
});
vi.mock('react-native', async () => ({
  View: await host('View')(),
  Linking: { openURL: vi.fn() },
  Platform: { OS: 'web' },
}));
vi.mock('../../../src/components/Image', async () => ({ Image: await host('Image')() }));
vi.mock('@oxy.so/bloom/message-media', async () => ({
  FileMessage: await host('FileMessage')(),
  ImageMessage: await host('ImageMessage')(),
  StickerMessage: await host('StickerMessage')(),
  VoiceMessage: await host('VoiceMessage')(),
}));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ oxyServices: {} }),
  // Oxy answers the signed-in caller a URL for their private file.
  useFileDownloadUrl: (_oxy: unknown, fileId: string) => ({
    url: `https://cloud.oxy.so/stream/${fileId}?token=t`,
    loading: false,
    error: null,
  }),
}));
vi.mock('../../../src/lib/labels', () => ({
  useLabels: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../src/lib/deferred/expo-audio', () => ({ loadExpoAudio: vi.fn() }));

import { TurnAttachments } from '../../../src/components/thread/TurnAttachments';

const sticker = {
  type: 'file',
  file: {
    file_id: 'sticker-1',
    filename: 'sticker.webp',
    mime: 'image/webp',
    kind: 'sticker',
    description: 'Sticker 😂 from the set "HappyCats"',
  },
};
const voice = {
  type: 'file',
  file: {
    file_id: 'voice-1',
    filename: 'voice.ogg',
    mime: 'audio/ogg',
    kind: 'voice',
    description: 'Voice note, 0:04',
    durationSeconds: 4,
    transcript: 'hola, ¿quedamos mañana?',
  },
};
const document = {
  type: 'file',
  file: { file_id: 'doc-1', filename: 'plan.pdf', mime: 'application/pdf', kind: 'document' },
};
const photo = {
  type: 'file',
  file: { file_id: 'photo-1', filename: 'photo.jpeg', mime: 'image/jpeg', kind: 'photo' },
};

function render(content: unknown): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(<TurnAttachments content={content as never} />);
  });
  if (!tree) throw new Error('not rendered');
  return tree;
}

describe('a turn’s attachments', () => {
  it('draws a channel’s sticker, voice note, document and photo as media, not as words', () => {
    const tree = render([sticker, voice, document, photo]);
    expect(tree.root.findByType('StickerMessage' as never).props).toMatchObject({
      source: 'https://cloud.oxy.so/stream/sticker-1?token=t',
      accessibilityLabel: 'Sticker 😂 from the set "HappyCats"',
    });
    expect(tree.root.findByType('VoiceMessage' as never).props).toMatchObject({
      duration: 4,
      transcript: 'hola, ¿quedamos mañana?',
      playing: false,
    });
    expect(tree.root.findByType('FileMessage' as never).props).toMatchObject({
      name: 'plan.pdf',
      mimeType: 'application/pdf',
    });
    expect(tree.root.findByType('ImageMessage' as never).props).toMatchObject({
      source: 'https://cloud.oxy.so/stream/photo-1?token=t',
    });
  });

  it('keeps a photo the app sent inline as the thumbnail it always was', () => {
    const tree = render([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
    expect(tree.root.findByType('Image' as never).props.source).toEqual({
      uri: 'data:image/png;base64,AAAA',
    });
  });

  it('draws nothing for a turn of words', () => {
    expect(render('hola').toJSON()).toBeNull();
    expect(render([{ type: 'text', text: 'hola' }]).toJSON()).toBeNull();
  });
});
