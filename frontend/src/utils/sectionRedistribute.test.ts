import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/endpoints', () => ({
  downloadSectionOsu: vi.fn(),
  uploadSectionOsu: vi.fn(),
}));

vi.mock('./crypto', () => ({
  decrypt: vi.fn(async (_key: unknown, ciphertext: string) => ciphertext),
  encrypt: vi.fn(async (_key: unknown, plaintext: string) => plaintext),
  sectionOsuVersionAad: vi.fn(() => 'aad'),
}));

import {
  splitSectionAtTime,
  mergeHitObjectsInto,
  mergeHitObjectsInto as _mergeForTypecheck,
  redistributeForShorten,
  redistributeForDelete,
} from './sectionRedistribute';
import { downloadSectionOsu, uploadSectionOsu } from '../api/endpoints';

void _mergeForTypecheck;

const dl = vi.mocked(downloadSectionOsu);
const ul = vi.mocked(uploadSectionOsu);

beforeEach(() => {
  dl.mockReset();
  ul.mockReset();
  ul.mockResolvedValue({} as never);
});

function makeSection(hitObjects: string[]): string {
  return `osu file format v14

[General]
AudioFilename: audio.mp3

[TimingPoints]
0,500,4,2,1,50,1,0

[HitObjects]
${hitObjects.join('\n')}
`;
}

describe('splitSectionAtTime', () => {
  it('keeps objects strictly before the cutoff and returns the rest', () => {
    const content = makeSection([
      '100,100,500,1,0',
      '100,100,1000,1,0',
      '100,100,1500,1,0',
    ]);
    const { remainingContent, movedRaws } = splitSectionAtTime(content, 1000);
    expect(movedRaws).toEqual(['100,100,1000,1,0', '100,100,1500,1,0']);
    expect(remainingContent).toContain('100,100,500,1,0');
    expect(remainingContent).not.toContain('100,100,1000,1,0');
    expect(remainingContent).not.toContain('100,100,1500,1,0');
  });

  it('returns empty moved list when no objects pass the cutoff', () => {
    const content = makeSection(['100,100,500,1,0']);
    const { movedRaws } = splitSectionAtTime(content, 2000);
    expect(movedRaws).toEqual([]);
  });

  it('preserves headers and timing points', () => {
    const content = makeSection(['100,100,1500,1,0']);
    const { remainingContent } = splitSectionAtTime(content, 1000);
    expect(remainingContent).toContain('AudioFilename: audio.mp3');
    expect(remainingContent).toContain('0,500,4,2,1,50,1,0');
  });
});

describe('mergeHitObjectsInto', () => {
  it('inserts the supplied lines and re-sorts by time', () => {
    const content = makeSection(['100,100,2000,1,0']);
    const merged = mergeHitObjectsInto(content, ['100,100,1000,1,0', '100,100,1500,1,0']);
    const hoIdx = merged.indexOf('[HitObjects]');
    const lines = merged.slice(hoIdx).split('\n').slice(1).filter((l) => l.trim() !== '');
    expect(lines).toEqual([
      '100,100,1000,1,0',
      '100,100,1500,1,0',
      '100,100,2000,1,0',
    ]);
  });

  it('is a no-op when given no extra objects', () => {
    const content = makeSection(['100,100,1000,1,0']);
    expect(mergeHitObjectsInto(content, [])).toBe(content);
  });

  it('dedupes by (time, raw) so a second merge of the same lines is idempotent', () => {
    const content = makeSection(['100,100,1000,1,0']);
    const once = mergeHitObjectsInto(content, ['100,100,1500,1,0']);
    const twice = mergeHitObjectsInto(once, ['100,100,1500,1,0']);
    const hoIdx = twice.indexOf('[HitObjects]');
    const lines = twice.slice(hoIdx).split('\n').slice(1).filter((l) => l.trim() !== '');
    expect(lines).toEqual(['100,100,1000,1,0', '100,100,1500,1,0']);
  });
});

const KEY = {} as CryptoKey;

function mockActiveSection(sectionId: string, content: string) {
  dl.mockImplementation(async (_diff: string, sid: string) => {
    if (sid === sectionId) {
      return { id: `v-${sid}`, encrypted_content: content } as never;
    }
    throw Object.assign(new Error('Not found'), {
      isAxiosError: true,
      response: { status: 404 },
    });
  });
}

function mockMultipleActiveSections(map: Record<string, string>) {
  dl.mockImplementation(async (_diff: string, sid: string) => {
    if (sid in map) {
      return { id: `v-${sid}`, encrypted_content: map[sid] } as never;
    }
    throw Object.assign(new Error('Not found'), {
      isAxiosError: true,
      response: { status: 404 },
    });
  });
}

describe('redistributeForShorten', () => {
  it('moves objects past newEndMs into next and uploads new versions for both', async () => {
    const source = makeSection(['100,100,500,1,0', '100,100,1500,1,0']);
    const next = makeSection(['100,100,2500,1,0']);
    mockMultipleActiveSections({ src: source, nxt: next });

    const result = await redistributeForShorten({
      difficultyId: 'd',
      mapsetId: 'm',
      sourceSectionId: 'src',
      nextSectionId: 'nxt',
      newEndMs: 1000,
      key: KEY,
    });

    expect(result.movedCount).toBe(1);
    expect(ul).toHaveBeenCalledTimes(2);

    const calls = ul.mock.calls;
    const sourcePayload = calls.find((c) => c[1] === 'src')![2];
    const nextPayload = calls.find((c) => c[1] === 'nxt')![2];
    expect(sourcePayload.encrypted_content).toContain('100,100,500,1,0');
    expect(sourcePayload.encrypted_content).not.toContain('100,100,1500,1,0');
    expect(nextPayload.encrypted_content).toContain('100,100,1500,1,0');
    expect(nextPayload.encrypted_content).toContain('100,100,2500,1,0');
  });

  it('is a no-op when source has no objects past the cutoff', async () => {
    mockMultipleActiveSections({
      src: makeSection(['100,100,500,1,0']),
      nxt: makeSection(['100,100,2500,1,0']),
    });
    const result = await redistributeForShorten({
      difficultyId: 'd',
      mapsetId: 'm',
      sourceSectionId: 'src',
      nextSectionId: 'nxt',
      newEndMs: 1000,
      key: KEY,
    });
    expect(result.movedCount).toBe(0);
    expect(ul).not.toHaveBeenCalled();
  });

  it('is a no-op when the source has no active .osu yet', async () => {
    mockActiveSection('nxt', makeSection(['100,100,2500,1,0']));
    const result = await redistributeForShorten({
      difficultyId: 'd',
      mapsetId: 'm',
      sourceSectionId: 'src',
      nextSectionId: 'nxt',
      newEndMs: 1000,
      key: KEY,
    });
    expect(result.movedCount).toBe(0);
    expect(ul).not.toHaveBeenCalled();
  });

  it('is idempotent across retries — re-running does not duplicate next-section objects', async () => {
    let sourceState = makeSection(['100,100,500,1,0', '100,100,1500,1,0']);
    let nextState = makeSection(['100,100,2500,1,0']);
    dl.mockImplementation(async (_diff: string, sid: string) => {
      if (sid === 'src') return { id: 'v-src', encrypted_content: sourceState } as never;
      if (sid === 'nxt') return { id: 'v-nxt', encrypted_content: nextState } as never;
      throw new Error('unexpected');
    });
    ul.mockImplementation(async (_diff: string, sid: string, payload: { encrypted_content: string }) => {
      if (sid === 'src') sourceState = payload.encrypted_content;
      if (sid === 'nxt') nextState = payload.encrypted_content;
      return {} as never;
    });

    await redistributeForShorten({
      difficultyId: 'd', mapsetId: 'm',
      sourceSectionId: 'src', nextSectionId: 'nxt',
      newEndMs: 1000, key: KEY,
    });
    // Retry with the post-move state already persisted.
    await redistributeForShorten({
      difficultyId: 'd', mapsetId: 'm',
      sourceSectionId: 'src', nextSectionId: 'nxt',
      newEndMs: 1000, key: KEY,
    });

    const hoIdx = nextState.indexOf('[HitObjects]');
    const nextLines = nextState.slice(hoIdx).split('\n').slice(1).filter((l) => l.trim() !== '');
    expect(nextLines).toEqual(['100,100,1500,1,0', '100,100,2500,1,0']);
  });
});

describe('redistributeForDelete', () => {
  it('moves all source objects into next and uploads only next', async () => {
    mockMultipleActiveSections({
      src: makeSection(['100,100,500,1,0', '100,100,1500,1,0']),
      nxt: makeSection(['100,100,2500,1,0']),
    });
    const result = await redistributeForDelete({
      difficultyId: 'd',
      mapsetId: 'm',
      deletedSectionId: 'src',
      nextSectionId: 'nxt',
      key: KEY,
    });
    expect(result.movedCount).toBe(2);
    expect(ul).toHaveBeenCalledTimes(1);
    const [, sectionId, payload] = ul.mock.calls[0];
    expect(sectionId).toBe('nxt');
    expect(payload.encrypted_content).toContain('100,100,500,1,0');
    expect(payload.encrypted_content).toContain('100,100,1500,1,0');
    expect(payload.encrypted_content).toContain('100,100,2500,1,0');
  });

  it('is a no-op when the deleted section has no active .osu', async () => {
    mockActiveSection('nxt', makeSection(['100,100,2500,1,0']));
    const result = await redistributeForDelete({
      difficultyId: 'd',
      mapsetId: 'm',
      deletedSectionId: 'src',
      nextSectionId: 'nxt',
      key: KEY,
    });
    expect(result.movedCount).toBe(0);
    expect(ul).not.toHaveBeenCalled();
  });

  it('is idempotent — re-running after a successful upload does not duplicate', async () => {
    const source = makeSection(['100,100,500,1,0']);
    let nextState = makeSection(['100,100,2500,1,0']);
    dl.mockImplementation(async (_diff: string, sid: string) => {
      if (sid === 'src') return { id: 'v-src', encrypted_content: source } as never;
      if (sid === 'nxt') return { id: 'v-nxt', encrypted_content: nextState } as never;
      throw new Error('unexpected');
    });
    ul.mockImplementation(async (_diff: string, sid: string, payload: { encrypted_content: string }) => {
      if (sid === 'nxt') nextState = payload.encrypted_content;
      return {} as never;
    });

    await redistributeForDelete({
      difficultyId: 'd', mapsetId: 'm',
      deletedSectionId: 'src', nextSectionId: 'nxt', key: KEY,
    });
    await redistributeForDelete({
      difficultyId: 'd', mapsetId: 'm',
      deletedSectionId: 'src', nextSectionId: 'nxt', key: KEY,
    });

    const hoIdx = nextState.indexOf('[HitObjects]');
    const lines = nextState.slice(hoIdx).split('\n').slice(1).filter((l) => l.trim() !== '');
    expect(lines).toEqual(['100,100,500,1,0', '100,100,2500,1,0']);
  });
});
