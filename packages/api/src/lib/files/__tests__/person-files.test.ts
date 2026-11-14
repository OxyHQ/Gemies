/**
 * Documents attached to a turn are read from Oxy Files AS THE PERSON, and the
 * model gets what it can read: the file for a model that takes files, the
 * extracted text otherwise, and a refusal rather than a turn about nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(
  () =>
    new Map<
      string,
      {
        mime: string;
        size: number;
        status?: string;
        originalName?: string;
        bytes: Uint8Array<ArrayBuffer>;
      }
    >(),
);
const seen = vi.hoisted(() => ({
  tokens: [] as string[],
  downloads: [] as string[],
  linked: [] as string[],
}));

vi.mock('../../oxy.js', async () => {
  const actual = await import('@oxy.so/core');
  class FakeOxyServices {
    assets = {
      get: async (id: string) => {
        const file = files.get(id);
        if (!file) throw new actual.OxyApiError('Not found', { status: 404, code: 'NOT_FOUND' });
        return {
          assetId: id,
          file: {
            id,
            mime: file.mime,
            size: file.size,
            status: file.status ?? 'active',
            originalName: file.originalName,
          },
        };
      },
      blob: async (id: string) => {
        seen.downloads.push(id);
        return new Blob([files.get(id)?.bytes ?? new Uint8Array()]);
      },
    };
    dispose() {}
  }
  const client = new FakeOxyServices();
  return {
    get oxy() {
      return {
        assets: {
          // This application's own link to a file it stored for the person (a channel's media).
          linkedDownloadUrls: async (ids: string[]) => {
            seen.linked.push(...ids);
            return ids
              .filter((id) => files.has(id))
              .map((id) => ({
                id,
                url: `https://files.test/${id}`,
                mime: files.get(id)?.mime ?? '',
                size: files.get(id)?.size ?? 0,
                expiresIn: 60,
                sha256: '',
              }));
          },
          withRequester: (proof: { requesterToken?: string; taskId?: string }) => {
            seen.tokens.push(proof.requesterToken ?? `task:${proof.taskId}`);
            return client.assets;
          },
        },
      };
    },
  };
});

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { v1: child, general: child } };
});

import {
  FilePartError,
  filePartsOf,
  MAX_FILES_PER_REQUEST,
  resolveFileParts,
} from '../person-files.js';
import type { ChatMessage } from '../../message-converter.js';
import { decodePng, docx, greyPage, pptx, scannedPdf, xlsx } from './document-fixtures.js';

/** A one-page PDF whose only text is "Rent is 900 EUR". */
function pdf(text: string): Uint8Array<ArrayBuffer> {
  const stream = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
  return new TextEncoder().encode(
    `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${stream.length}>>stream
${stream}
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`,
  );
}

const message = (...fileIds: string[]): ChatMessage => ({
  id: 'm1',
  role: 'user',
  content: [
    { type: 'text', text: 'look' },
    ...fileIds.map((id) => ({ type: 'file', file: { file_id: id, filename: `${id}.bin` } })),
  ],
});

const person = { personAccountId: 'person-1', accessToken: 'PERSON-TOKEN' };

beforeEach(() => {
  files.clear();
  seen.tokens.length = 0;
  seen.downloads.length = 0;
  seen.linked.length = 0;
});

describe('filePartsOf', () => {
  it('collects distinct ids across the history', () => {
    const refs = filePartsOf([
      message('a', 'b'),
      { role: 'assistant', content: 'ok' },
      message('a'),
    ]);
    expect([...refs.keys()]).toEqual(['a', 'b']);
  });

  it('reads only the newest message’s files for a channel turn, which resends its whole history', () => {
    const history: ChatMessage[] = Array.from({ length: 12 }, (_, i) => message(`old-${i}`));
    const refs = filePartsOf([...history, message('new')], { latestTurnOnly: true });
    expect([...refs.keys()]).toEqual(['new']);
    expect(() => filePartsOf([...history, message('new')])).toThrow(FilePartError);
  });

  it('says what a channel’s media is beside the file itself, and a voice note in its words', async () => {
    files.set('sticker', { mime: 'image/webp', size: 4, bytes: new Uint8Array([1, 2, 3, 4]) });
    files.set('voice', { mime: 'audio/ogg', size: 10, bytes: new Uint8Array(10) });
    const turn: ChatMessage = {
      role: 'user',
      content: [
        {
          type: 'file',
          file: { file_id: 'sticker', description: 'Sticker 😂 from the set "HappyCats"' },
        },
        {
          type: 'file',
          file: { file_id: 'voice', description: 'Voice note, 0:04', transcript: 'hola' },
        },
      ],
    };
    const resolved = await resolveFileParts(filePartsOf([turn]), {
      ...person,
      modelAcceptsFiles: false,
    });
    expect(resolved.get('sticker')).toEqual([
      { type: 'text', text: '[Sticker 😂 from the set "HappyCats"]' },
      { type: 'image', image: expect.any(Uint8Array), mediaType: 'image/webp' },
    ]);
    expect(resolved.get('voice')).toEqual([
      { type: 'text', text: '[Voice note, 0:04. It says: hola]' },
    ]);
  });

  it('reads a channel turn’s media through the application’s own link, never failing the turn', async () => {
    // A channel turn has no session, and the task that stored its media is not a proof Oxy takes
    // to read it back (production: "The file … could not be opened" on a sticker).
    files.set('sticker', { mime: 'image/webp', size: 4, bytes: new Uint8Array([1, 2, 3, 4]) });
    files.set('voice', { mime: 'audio/ogg', size: 10, bytes: new Uint8Array(10) });
    vi.stubGlobal('fetch', async (url: string) => {
      const id = String(url).split('/').pop() ?? '';
      return new Response(files.get(id)?.bytes ?? new Uint8Array());
    });
    try {
      const turn: ChatMessage = {
        role: 'user',
        content: [
          { type: 'file', file: { file_id: 'sticker', description: 'Sticker 😂' } },
          {
            type: 'file',
            file: { file_id: 'voice', description: 'Voice note, 0:04', transcript: 'hola' },
          },
          { type: 'file', file: { file_id: 'gone', description: 'Photo' } },
        ],
      };
      const resolved = await resolveFileParts(filePartsOf([turn]), {
        personAccountId: 'person-1',
        accessToken: undefined,
        taskId: 'channel-task',
        modelAcceptsFiles: false,
        channel: true,
      });
      expect(resolved.get('sticker')).toEqual([
        { type: 'text', text: '[Sticker 😂]' },
        { type: 'image', image: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/webp' },
      ]);
      expect(resolved.get('voice')).toEqual([
        { type: 'text', text: '[Voice note, 0:04. It says: hola]' },
      ]);
      // A file that cannot be opened is said, and the turn goes on.
      expect(resolved.get('gone')).toEqual([
        { type: 'text', text: '[Photo; it could not be opened]' },
      ]);
      // Never as a requester: no session or task read.
      expect(seen.tokens).toEqual([]);
      expect(seen.linked.sort()).toEqual(['gone', 'sticker', 'voice']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a malformed part, a file outside a user message, and too many files', () => {
    expect(() =>
      filePartsOf([{ role: 'user', content: [{ type: 'file', file: { file_id: '' } }] }]),
    ).toThrow(FilePartError);
    expect(() =>
      filePartsOf([{ role: 'assistant', content: [{ type: 'file', file: { file_id: 'a' } }] }]),
    ).toThrow(expect.objectContaining({ code: 'invalid_file_part' }));
    const many = Array.from({ length: MAX_FILES_PER_REQUEST + 1 }, (_, i) => `f${i}`);
    expect(() => filePartsOf([message(...many)])).toThrow(
      expect.objectContaining({ code: 'too_many_files' }),
    );
  });
});

describe('resolveFileParts', () => {
  it("reads the file with the person's own bearer", async () => {
    files.set('lease', { mime: 'application/pdf', size: 300, bytes: pdf('Rent is 900 EUR') });
    await resolveFileParts(filePartsOf([message('lease')]), { ...person, modelAcceptsFiles: true });
    expect(seen.tokens).toEqual(['PERSON-TOKEN']);
  });

  it('hands a model that takes files the PDF itself', async () => {
    const bytes = pdf('Rent is 900 EUR');
    files.set('lease', { mime: 'application/pdf', size: 300, originalName: 'lease.pdf', bytes });
    const resolved = await resolveFileParts(filePartsOf([message('lease')]), {
      ...person,
      modelAcceptsFiles: true,
    });
    expect(resolved.get('lease')).toEqual([
      {
        type: 'file',
        data: bytes,
        mediaType: 'application/pdf',
        filename: 'lease.pdf',
      },
    ]);
  });

  it('gives any other model the text of the PDF, extracted here', async () => {
    files.set('lease', {
      mime: 'application/pdf',
      size: 300,
      originalName: 'lease.pdf',
      bytes: pdf('Rent is 900 EUR'),
    });
    const resolved = await resolveFileParts(filePartsOf([message('lease')]), {
      ...person,
      personAccountId: 'person-text',
      modelAcceptsFiles: false,
    });
    const [part] = resolved.get('lease') ?? [];
    expect(part?.type).toBe('text');
    expect(part?.type === 'text' ? part.text : '').toContain('[Attached document: lease.pdf]');
    expect(part?.type === 'text' ? part.text : '').toContain('Rent is 900 EUR');
  });

  it('reads a text file as text, whatever the model, and trusts Oxy’s mime over the part’s', async () => {
    files.set('notes', {
      mime: 'text/markdown',
      size: 5,
      bytes: new TextEncoder().encode('# hola'),
    });
    const resolved = await resolveFileParts(
      filePartsOf([
        {
          role: 'user',
          content: [{ type: 'file', file: { file_id: 'notes', mime: 'application/pdf' } }],
        },
      ]),
      { ...person, modelAcceptsFiles: true },
    );
    expect(resolved.get('notes')).toMatchObject([{ type: 'text' }]);
  });

  it('refuses a type the model cannot read instead of answering without it', async () => {
    files.set('sheet', { mime: 'application/vnd.ms-excel', size: 10, bytes: new Uint8Array(10) });
    await expect(
      resolveFileParts(filePartsOf([message('sheet')]), { ...person, modelAcceptsFiles: false }),
    ).rejects.toMatchObject({ code: 'file_type_unsupported' });
    expect(seen.downloads).toEqual([]);
  });

  it('reads a voice note that arrived on a channel as its transcript, without downloading it', async () => {
    files.set('voice', { mime: 'audio/ogg', size: 10, bytes: new Uint8Array(10) });
    const turn: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: '[Voice note, 0:03]' },
        { type: 'file', file: { file_id: 'voice', filename: 'voice.ogg', transcript: 'hola' } },
      ],
    };
    const resolved = await resolveFileParts(filePartsOf([turn]), {
      ...person,
      modelAcceptsFiles: false,
    });
    expect(resolved.get('voice')).toEqual([
      { type: 'text', text: '[Attached audio: voice.ogg. It says: hola]' },
    ]);
    expect(seen.downloads).toEqual([]);
    // Audio with no transcript is still refused by a model that cannot hear it.
    files.set('song', { mime: 'audio/mpeg', size: 10, bytes: new Uint8Array(10) });
    await expect(
      resolveFileParts(filePartsOf([message('song')]), { ...person, modelAcceptsFiles: false }),
    ).rejects.toMatchObject({ code: 'file_type_unsupported' });
  });

  it('refuses a file the person cannot open, a trashed one and an oversized one, without downloading', async () => {
    await expect(
      resolveFileParts(filePartsOf([message('missing')]), { ...person, modelAcceptsFiles: true }),
    ).rejects.toMatchObject({ code: 'file_unavailable' });
    files.set('old', { mime: 'text/plain', size: 1, status: 'trash', bytes: new Uint8Array(1) });
    await expect(
      resolveFileParts(filePartsOf([message('old')]), { ...person, modelAcceptsFiles: true }),
    ).rejects.toMatchObject({ code: 'file_unavailable' });
    files.set('huge', { mime: 'text/plain', size: 50 * 1024 * 1024, bytes: new Uint8Array(1) });
    await expect(
      resolveFileParts(filePartsOf([message('huge')]), { ...person, modelAcceptsFiles: true }),
    ).rejects.toMatchObject({ code: 'file_too_large' });
    expect(seen.downloads).toEqual([]);
  });

  it('needs the person’s own session', async () => {
    await expect(
      resolveFileParts(filePartsOf([message('lease')]), {
        personAccountId: 'person-1',
        accessToken: undefined,
        modelAcceptsFiles: true,
      }),
    ).rejects.toMatchObject({ code: 'file_session_required' });
  });

  it('reads an unchanged document once while the history is resent', async () => {
    files.set('cached', { mime: 'text/plain', size: 4, bytes: new TextEncoder().encode('once') });
    const refs = filePartsOf([message('cached')]);
    await resolveFileParts(refs, {
      ...person,
      personAccountId: 'cache-1',
      modelAcceptsFiles: false,
    });
    await resolveFileParts(refs, {
      ...person,
      personAccountId: 'cache-1',
      modelAcceptsFiles: false,
    });
    expect(seen.downloads).toEqual(['cached']);
  });
  it('reads Word, PowerPoint and Excel as text, even for a model that takes files', async () => {
    const office = 'application/vnd.openxmlformats-officedocument';
    files.set('letter', {
      mime: `${office}.wordprocessingml.document`,
      size: 900,
      originalName: 'letter.docx',
      bytes: docx(),
    });
    files.set('deck', {
      mime: `${office}.presentationml.presentation`,
      size: 900,
      originalName: 'deck.pptx',
      bytes: pptx(),
    });
    files.set('rent', {
      mime: 'application/vnd.ms-excel.sheet.macroEnabled.12',
      size: 900,
      originalName: 'rent.xlsm',
      bytes: xlsx(),
    });
    const resolved = await resolveFileParts(filePartsOf([message('letter', 'deck', 'rent')]), {
      ...person,
      personAccountId: 'person-office',
      modelAcceptsFiles: true,
    });
    const text = (id: string) => {
      const [part] = resolved.get(id) ?? [];
      return part?.type === 'text' ? part.text : '';
    };
    expect(text('letter')).toMatch(
      /^\[Attached document: letter\.docx\]\n\nLease & terms\nRent:\t900 EUR/,
    );
    expect(text('deck')).toContain('Slide 1\nQuarterly results');
    expect(text('deck')).toContain('Notes:\nMention the hiring freeze');
    expect(text('rent')).toContain('Sheet: Rent\nTenant,"Amount ""EUR"""');
  });

  it('refuses an Office file it cannot read rather than answer without it', async () => {
    files.set('broken', {
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 9,
      bytes: new TextEncoder().encode('not a zip'),
    });
    await expect(
      resolveFileParts(filePartsOf([message('broken')]), { ...person, modelAcceptsFiles: false }),
    ).rejects.toMatchObject({ code: 'file_unavailable' });
  });

  const scannedPage = {
    width: 600,
    height: 800,
    colorSpace: 'DeviceGray' as const,
    bitsPerComponent: 8 as const,
    pixels: greyPage(600, 800),
  };

  it('gives a scanned PDF to a model that reads no files as its pages, named, and reads it once', async () => {
    files.set('scan', {
      mime: 'application/pdf',
      size: 9_000,
      originalName: 'scan.pdf',
      bytes: scannedPdf([scannedPage, scannedPage]),
    });
    const refs = filePartsOf([message('scan')]);
    const options = { ...person, personAccountId: 'person-scan', modelAcceptsFiles: false };
    const parts = (await resolveFileParts(refs, options)).get('scan') ?? [];
    expect(parts.map((part) => part.type)).toEqual(['text', 'image', 'image']);
    expect(parts[0]).toEqual({
      type: 'text',
      text: '[Attached document: scan.pdf. It is scanned and has no text, so its pages follow as images: pages 1-2 of 2. Read the text from them.]',
    });
    const image = parts[1];
    expect(image).toMatchObject({ type: 'image', mediaType: 'image/png' });
    expect(image.type === 'image' && decodePng(image.image as Uint8Array)).toMatchObject({
      width: 600,
      height: 800,
    });
    await resolveFileParts(refs, options);
    expect(seen.downloads).toEqual(['scan']);
  });

  it('still hands a scanned PDF itself to a model that takes files', async () => {
    files.set('scan', { mime: 'application/pdf', size: 9_000, bytes: scannedPdf([scannedPage]) });
    const resolved = await resolveFileParts(filePartsOf([message('scan')]), {
      ...person,
      modelAcceptsFiles: true,
    });
    expect(resolved.get('scan')).toMatchObject([{ type: 'file', mediaType: 'application/pdf' }]);
  });
});
