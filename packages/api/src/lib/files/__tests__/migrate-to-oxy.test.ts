import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The copy into Oxy Files (`lib/files/migrate-to-oxy.ts`): a preview writes
 * nothing, an apply records the file only once Oxy's hash matches, a row that
 * changed meanwhile is skipped, and the private kinds — library uploads as the
 * person's private files, spoken clips as Alia's, skill files by their owner —
 * move with no switch, paced to Oxy's
 * upload budget and resumed after a 429. The repository writes are
 * `db/__tests__/oxyFiles.pgdb.test.ts`.
 */

const H = vi.hoisted(() => ({
  skills: [] as {
    id: string;
    path: string;
    mime: string;
    sha256: string;
    s3Key: string;
    ownerOxyUserId: string | null;
  }[],
  library: [] as {
    id: string;
    url: string | null;
    ownerOxyUserId: string;
    type: string;
    name: string;
  }[],
  speech: [] as { cacheKey: string; objectKey: string | null }[],
  adoptedLibrary: vi.fn(),
  adoptedSpeech: vi.fn(),
  copied: vi.fn(),
  adoptedSkill: vi.fn(),
}));

vi.mock('../../../db/library/libraryFileRepository.js', () => ({
  listLibraryFilesOnLegacyStorage: async (_db: unknown, after: string) =>
    H.library.filter((row) => row.id > after),
  adoptLibraryOxyFile: async (...args: unknown[]) => H.adoptedLibrary(...args),
}));
vi.mock('../../../db/chat/speechClipRepository.js', () => ({
  listSpeechClipsOnLegacyStorage: async (_db: unknown, after: string) =>
    H.speech.filter((row) => row.cacheKey > after),
  adoptSpeechClipOxyFile: async (...args: unknown[]) => H.adoptedSpeech(...args),
}));
vi.mock('../../../db/agents/skillRepository.js', () => ({
  listSkillFilesOnLegacyStorage: async (_db: unknown, after: string) =>
    H.skills.filter((row) => row.id > after),
  adoptSkillFileOxyFile: async (...args: unknown[]) => H.adoptedSkill(...args),
}));
vi.mock('../oxy-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../oxy-files.js')>();
  return { ...actual, copyIntoOxy: async (input: unknown) => H.copied(input) };
});
vi.mock('../../s3.js', () => ({ readS3Object: vi.fn() }));

const { migrateKind, MIGRATION_UPLOADS_PER_MINUTE, RATE_LIMITED_MAX_WAITS, RATE_LIMITED_WAIT_MS } =
  await import('../migrate-to-oxy.js');

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const deps = {
  db: {} as never,
  readLegacy: vi.fn(async () => Buffer.from('#!/bin/sh')),
  sleep: vi.fn(async (_ms: number) => {}),
  now: () => 0,
};

async function collect(kind: Parameters<typeof migrateKind>[0], apply: boolean) {
  const lines = [];
  for await (const line of migrateKind(kind, deps, { apply })) lines.push(line);
  return lines;
}

beforeEach(() => {
  vi.clearAllMocks();
  H.skills = [];
  H.library = [];
  H.speech = [];
  H.copied.mockResolvedValue('oxy-file');
});

describe('private kinds', () => {
  const script = (id: string) => ({
    id,
    path: 'run.sh',
    mime: 'text/x-sh',
    sha256: sha(Buffer.from('#!/bin/sh')),
    s3Key: `legacy/${id}`,
    ownerOxyUserId: null,
  });

  it('move with no switch', async () => {
    H.skills = [script('k1')];
    H.adoptedSkill.mockResolvedValue(true);
    const lines = await collect('skills', true);
    expect(lines.map((line) => line.outcome)).toEqual(['copied']);
  });

  it('pace an apply to its share of Oxy’s upload budget — a large upload spends two', async () => {
    // A clock that only the pacing's own waits move, so the spacing is exact.
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    H.skills = [script('k1'), script('k2'), script('k3')];
    H.adoptedSkill.mockResolvedValue(true);
    for await (const _ of migrateKind(
      'skills',
      { ...deps, sleep, now: () => clock },
      { apply: true },
    ))
      void _;
    const spacing = 60_000 / MIGRATION_UPLOADS_PER_MINUTE;
    // text/x-sh is a large upload (start + complete): each item waits for two calls' worth.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2 * spacing, 2 * spacing]);
    expect(MIGRATION_UPLOADS_PER_MINUTE).toBeLessThan(30);
  });

  it('preview spends no upload budget at all', async () => {
    H.skills = [script('k1'), script('k2')];
    await collect('skills', false);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('wait out a 429 and try the same item again, never reporting it failed', async () => {
    H.skills = [script('k1'), script('k2')];
    H.adoptedSkill.mockResolvedValue(true);
    H.copied
      .mockRejectedValueOnce(Object.assign(new Error('Too Many Requests'), { status: 429 }))
      .mockResolvedValue('oxy-file');
    const lines = await collect('skills', true);
    expect(lines.map((line) => [line.entityId, line.outcome])).toEqual([
      ['k1', 'copied'],
      ['k2', 'copied'],
    ]);
    expect(deps.sleep).toHaveBeenCalledWith(RATE_LIMITED_WAIT_MS);
    expect(H.copied).toHaveBeenCalledTimes(3);
  });

  it('give up on an item only after Oxy keeps answering 429', async () => {
    H.skills = [script('k1')];
    H.copied.mockRejectedValue(Object.assign(new Error('Too Many Requests'), { status: 429 }));
    const [line] = await collect('skills', true);
    expect(line).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/429/) });
    expect(H.copied).toHaveBeenCalledTimes(RATE_LIMITED_MAX_WAITS + 1);
    expect(H.adoptedSkill).not.toHaveBeenCalled();
  });

  it('a skill file whose legacy bytes differ from its recorded sha256 is never copied', async () => {
    H.skills = [
      {
        id: 'k1',
        path: 'run.sh',
        mime: 'text/x-sh',
        sha256: '0'.repeat(64),
        s3Key: 'legacy/k1',
        ownerOxyUserId: null,
      },
    ];
    const [line] = await collect('skills', true);
    expect(line).toMatchObject({
      outcome: 'failed',
      reason: 'legacy bytes differ from the recorded sha256',
    });
    expect(H.copied).not.toHaveBeenCalled();
  });

  it('copies a catalogue skill file as Alia’s and leaves a person’s on legacy storage', async () => {
    const bytes = Buffer.from('#!/bin/sh');
    H.skills = [
      {
        id: 'k1',
        path: 'a/run.sh',
        mime: 'text/x-sh',
        sha256: sha(bytes),
        s3Key: 'legacy/k1',
        ownerOxyUserId: null,
      },
      {
        id: 'k2',
        path: 'run.sh',
        mime: 'text/x-sh',
        sha256: sha(bytes),
        s3Key: 'legacy/k2',
        ownerOxyUserId: 'u1',
      },
    ];
    H.adoptedSkill.mockResolvedValue(true);
    const lines = await collect('skills', true);
    expect(lines.map((line) => line.outcome)).toEqual(['copied', 'skipped']);
    expect(lines[1]?.reason).toMatch(/their own requester proof/);
    expect(H.copied.mock.calls.map(([input]) => (input as { owner: unknown }).owner)).toEqual([
      { kind: 'alia' },
    ]);
  });
});

describe('library uploads and spoken clips', () => {
  beforeEach(() => {
    H.library = [
      {
        id: 'l1',
        url: 'legacy/l1.pdf',
        ownerOxyUserId: 'u1',
        type: 'application/pdf',
        name: 'a.pdf',
      },
      { id: 'l2', url: null, ownerOxyUserId: 'u2', type: 'image/png', name: 'b.png' },
    ];
    H.speech = [{ cacheKey: 'c1', objectKey: 'legacy/c1.mp3' }];
    H.adoptedLibrary.mockResolvedValue(true);
    H.adoptedSpeech.mockResolvedValue(true);
  });

  it.each([false, true])(
    'a library upload is the PERSON’s: never sent to Oxy without their requester proof (apply: %s)',
    async (apply) => {
      const lines = await collect('library', apply);
      expect(lines).toEqual([
        expect.objectContaining({
          entityId: 'l1',
          outcome: 'skipped',
          reason: expect.stringMatching(/their own requester proof/),
        }),
      ]);
      expect(H.copied).not.toHaveBeenCalled();
      expect(H.adoptedLibrary).not.toHaveBeenCalled();
    },
  );

  it('apply: copies a spoken clip as ALIA’s audio file', async () => {
    const lines = await collect('speech', true);
    expect(H.copied).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'speech_clip',
        owner: { kind: 'alia' },
        mime: 'audio/mpeg',
      }),
    );
    expect(H.adoptedSpeech).toHaveBeenCalledWith({}, 'c1', 'oxy-file');
    expect(lines.map((line) => line.outcome)).toEqual(['copied']);
  });

  it('preview: reads and hashes every legacy object, writes nothing', async () => {
    const clip = Buffer.from('#!/bin/sh');
    const lines = await collect('speech', false);
    expect(lines).toEqual([
      {
        kind: 'speech',
        entityId: 'c1',
        outcome: 'would_copy',
        sha256: sha(clip),
        bytes: clip.length,
      },
    ]);
    expect(H.copied).not.toHaveBeenCalled();
    expect(H.adoptedSpeech).not.toHaveBeenCalled();
    // A report carries hashes, never addresses.
    expect(JSON.stringify(lines)).not.toMatch(/https?:/);
  });

  it('skips a row that changed during the copy', async () => {
    H.adoptedSpeech.mockResolvedValueOnce(false);
    const [line] = await collect('speech', true);
    expect(line).toMatchObject({ outcome: 'skipped', reason: 'row changed during the copy' });
  });

  it('leaves an item Oxy does not take on legacy storage and reports it', async () => {
    H.copied.mockRejectedValueOnce(new Error('Oxy stored a private speech_clip as public'));
    const [line] = await collect('speech', true);
    expect(line).toMatchObject({
      outcome: 'failed',
      reason: 'Oxy stored a private speech_clip as public',
    });
    expect(H.adoptedSpeech).not.toHaveBeenCalled();
  });
});
