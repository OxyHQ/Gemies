import { describe, expect, it } from 'vitest';
import { channelMessageIsEmpty, turnContentText } from '../src/channel-messages.js';

describe('a channel message', () => {
  it('is empty only when it carries nothing at all', () => {
    expect(channelMessageIsEmpty({ text: '  ' })).toBe(true);
    expect(channelMessageIsEmpty({ text: '', media: [{ kind: 'sticker' }] })).toBe(false);
    expect(channelMessageIsEmpty({ text: '', dice: { emoji: '🎲', value: 3 } })).toBe(false);
    expect(channelMessageIsEmpty({ text: '', unsupported: 'A game' })).toBe(false);
  });

  it('is read in words on a later turn: its text, and a line per file with its transcript', () => {
    expect(turnContentText('hola')).toBe('hola');
    expect(
      turnContentText([
        { type: 'text', text: '[Voice note, 0:03]' },
        { type: 'file', file: { file_id: 'v', filename: 'voice.ogg', transcript: 'hola' } },
        { type: 'file', file: { file_id: 'p', filename: 'photo.jpg' } },
        { type: 'image_url', image_url: { url: 'data:' } },
      ]),
    ).toBe(
      '[Voice note, 0:03]\n[Attached audio: voice.ogg. It says: hola]\n[Attached: photo.jpg]\n[Attached: an image]',
    );
    expect(turnContentText(null)).toBe('');
  });
});
