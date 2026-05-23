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
  splitNegativeTimingPointsAtTime,
  mergeHitObjectsInto,
  mergeNegativeTimingPointsInto,
  mergeHitObjectsInto as _mergeForTypecheck,
  redistributeForShorten,
  redistributeForDelete,
  redistributeForMerge,
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

function makeSectionWithTPs(timingPoints: string[], hitObjects: string[]): string {
  return `osu file format v14

[General]
AudioFilename: audio.mp3

[TimingPoints]
${['0,500,4,2,1,50,1,0', ...timingPoints].join('\n')}

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

describe('splitNegativeTimingPointsAtTime', () => {
  it('moves negative TPs at or after the cutoff and keeps the rest', () => {
    const content = makeSectionWithTPs(
      ['500,-50,4,2,1,50,0,0', '1000,-25,4,2,1,50,0,0', '1500,-100,4,2,1,50,0,0'],
      [],
    );
    const { remainingContent, movedRaws } = splitNegativeTimingPointsAtTime(content, 1000);
    expect(movedRaws).toEqual(['1000,-25,4,2,1,50,0,0', '1500,-100,4,2,1,50,0,0']);
    expect(remainingContent).toContain('500,-50,4,2,1,50,0,0');
    expect(remainingContent).not.toContain('1000,-25,4,2,1,50,0,0');
    expect(remainingContent).not.toContain('1500,-100,4,2,1,50,0,0');
  });

  it('always keeps positive (BPM) timing points regardless of cutoff', () => {
    const content = makeSectionWithTPs(['2000,-50,4,2,1,50,0,0'], []);
    const { remainingContent, movedRaws } = splitNegativeTimingPointsAtTime(content, 0);
    // Positive at time 0 stays, negative at time 2000 moves.
    expect(remainingContent).toContain('0,500,4,2,1,50,1,0');
    expect(movedRaws).toEqual(['2000,-50,4,2,1,50,0,0']);
  });

  it('returns empty moved list when no negatives pass the cutoff', () => {
    const content = makeSectionWithTPs(['500,-50,4,2,1,50,0,0'], []);
    const { movedRaws } = splitNegativeTimingPointsAtTime(content, 2000);
    expect(movedRaws).toEqual([]);
  });

  it('is a no-op when the section has no [TimingPoints] block at all', () => {
    const content = `osu file format v14\n\n[HitObjects]\n100,100,500,1,0\n`;
    const { remainingContent, movedRaws } = splitNegativeTimingPointsAtTime(content, 100);
    expect(movedRaws).toEqual([]);
    expect(remainingContent).toBe(content);
  });
});

describe('mergeNegativeTimingPointsInto', () => {
  it('inserts the supplied lines into [TimingPoints] and re-sorts by time', () => {
    const content = makeSectionWithTPs(['2000,-50,4,2,1,50,0,0'], []);
    const merged = mergeNegativeTimingPointsInto(content, [
      '1000,-25,4,2,1,50,0,0',
      '1500,-75,4,2,1,50,0,0',
    ]);
    const tpStart = merged.indexOf('[TimingPoints]');
    const tpEnd = merged.indexOf('[HitObjects]');
    const lines = merged.slice(tpStart, tpEnd).split('\n').slice(1).filter((l) => l.trim() !== '');
    expect(lines).toEqual([
      '0,500,4,2,1,50,1,0',
      '1000,-25,4,2,1,50,0,0',
      '1500,-75,4,2,1,50,0,0',
      '2000,-50,4,2,1,50,0,0',
    ]);
  });

  it('is a no-op when given no extra points', () => {
    const content = makeSectionWithTPs(['1000,-50,4,2,1,50,0,0'], []);
    expect(mergeNegativeTimingPointsInto(content, [])).toBe(content);
  });

  it('dedupes by (time, raw) so a second merge of the same lines is idempotent', () => {
    const content = makeSectionWithTPs([], []);
    const once = mergeNegativeTimingPointsInto(content, ['1500,-50,4,2,1,50,0,0']);
    const twice = mergeNegativeTimingPointsInto(once, ['1500,-50,4,2,1,50,0,0']);
    const tpStart = twice.indexOf('[TimingPoints]');
    const tpEnd = twice.indexOf('[HitObjects]');
    const lines = twice.slice(tpStart, tpEnd).split('\n').slice(1).filter((l) => l.trim() !== '');
    expect(lines).toEqual(['0,500,4,2,1,50,1,0', '1500,-50,4,2,1,50,0,0']);
  });

  it('silently drops positive TPs in addedRaws (caller-misuse guard)', () => {
    const content = makeSectionWithTPs([], []);
    const merged = mergeNegativeTimingPointsInto(content, [
      '1000,400,4,2,1,50,1,0', // positive — must be dropped
      '1500,-50,4,2,1,50,0,0', // negative — must be kept
    ]);
    expect(merged).not.toContain('1000,400,4,2,1,50,1,0');
    expect(merged).toContain('1500,-50,4,2,1,50,0,0');
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

  it('migrates negative timing points past the cutoff alongside hit objects', async () => {
    const source = makeSectionWithTPs(
      ['500,-50,4,2,1,50,0,0', '1500,-25,4,2,1,50,0,0'],
      ['100,100,500,1,0', '100,100,1500,1,0'],
    );
    const next = makeSectionWithTPs([], ['100,100,2500,1,0']);
    mockMultipleActiveSections({ src: source, nxt: next });

    await redistributeForShorten({
      difficultyId: 'd', mapsetId: 'm',
      sourceSectionId: 'src', nextSectionId: 'nxt',
      newEndMs: 1000, key: KEY,
    });

    const sourcePayload = ul.mock.calls.find((c) => c[1] === 'src')![2];
    const nextPayload = ul.mock.calls.find((c) => c[1] === 'nxt')![2];
    expect(sourcePayload.encrypted_content).toContain('500,-50,4,2,1,50,0,0');
    expect(sourcePayload.encrypted_content).not.toContain('1500,-25,4,2,1,50,0,0');
    expect(nextPayload.encrypted_content).toContain('1500,-25,4,2,1,50,0,0');
  });

  it('uploads both sections when only negative TPs (no HOs) pass the cutoff', async () => {
    const source = makeSectionWithTPs(['1500,-25,4,2,1,50,0,0'], ['100,100,500,1,0']);
    const next = makeSection(['100,100,2500,1,0']);
    mockMultipleActiveSections({ src: source, nxt: next });

    await redistributeForShorten({
      difficultyId: 'd', mapsetId: 'm',
      sourceSectionId: 'src', nextSectionId: 'nxt',
      newEndMs: 1000, key: KEY,
    });

    expect(ul).toHaveBeenCalledTimes(2);
    const nextPayload = ul.mock.calls.find((c) => c[1] === 'nxt')![2];
    expect(nextPayload.encrypted_content).toContain('1500,-25,4,2,1,50,0,0');
  });
});

describe('redistributeForMerge', () => {
  it('moves all source objects into target and uploads only target', async () => {
    mockMultipleActiveSections({
      src: makeSection(['100,100,500,1,0', '100,100,1500,1,0']),
      tgt: makeSection(['100,100,2500,1,0']),
    });
    const result = await redistributeForMerge({
      difficultyId: 'd',
      mapsetId: 'm',
      targetSectionId: 'tgt',
      sourceSectionId: 'src',
      key: KEY,
    });
    expect(result.movedCount).toBe(2);
    expect(ul).toHaveBeenCalledTimes(1);
    const [, sectionId, payload] = ul.mock.calls[0];
    expect(sectionId).toBe('tgt');
    expect(payload.encrypted_content).toContain('100,100,500,1,0');
    expect(payload.encrypted_content).toContain('100,100,1500,1,0');
    expect(payload.encrypted_content).toContain('100,100,2500,1,0');
  });

  it('is a no-op when the source has no active .osu', async () => {
    mockActiveSection('tgt', makeSection(['100,100,2500,1,0']));
    const result = await redistributeForMerge({
      difficultyId: 'd',
      mapsetId: 'm',
      targetSectionId: 'tgt',
      sourceSectionId: 'src',
      key: KEY,
    });
    expect(result.movedCount).toBe(0);
    expect(ul).not.toHaveBeenCalled();
  });

  it('is a no-op when source has .osu but zero hit objects', async () => {
    mockMultipleActiveSections({
      src: makeSection([]),
      tgt: makeSection(['100,100,2500,1,0']),
    });
    const result = await redistributeForMerge({
      difficultyId: 'd',
      mapsetId: 'm',
      targetSectionId: 'tgt',
      sourceSectionId: 'src',
      key: KEY,
    });
    expect(result.movedCount).toBe(0);
    expect(ul).not.toHaveBeenCalled();
  });

  it('builds an empty shell from source headers when target has no .osu', async () => {
    mockActiveSection('src', makeSection(['100,100,500,1,0']));
    const result = await redistributeForMerge({
      difficultyId: 'd',
      mapsetId: 'm',
      targetSectionId: 'tgt',
      sourceSectionId: 'src',
      key: KEY,
    });
    expect(result.movedCount).toBe(1);
    expect(ul).toHaveBeenCalledTimes(1);
    const [, sectionId, payload] = ul.mock.calls[0];
    expect(sectionId).toBe('tgt');
    expect(payload.encrypted_content).toContain('AudioFilename: audio.mp3');
    expect(payload.encrypted_content).toContain('100,100,500,1,0');
  });

  it('is idempotent — re-running after a successful upload does not duplicate', async () => {
    const source = makeSection(['100,100,500,1,0']);
    let targetState = makeSection(['100,100,2500,1,0']);
    dl.mockImplementation(async (_diff: string, sid: string) => {
      if (sid === 'src') return { id: 'v-src', encrypted_content: source } as never;
      if (sid === 'tgt') return { id: 'v-tgt', encrypted_content: targetState } as never;
      throw new Error('unexpected');
    });
    ul.mockImplementation(async (_diff: string, sid: string, payload: { encrypted_content: string }) => {
      if (sid === 'tgt') targetState = payload.encrypted_content;
      return {} as never;
    });

    await redistributeForMerge({
      difficultyId: 'd', mapsetId: 'm',
      targetSectionId: 'tgt', sourceSectionId: 'src', key: KEY,
    });
    await redistributeForMerge({
      difficultyId: 'd', mapsetId: 'm',
      targetSectionId: 'tgt', sourceSectionId: 'src', key: KEY,
    });

    const hoIdx = targetState.indexOf('[HitObjects]');
    const lines = targetState.slice(hoIdx).split('\n').slice(1).filter((l) => l.trim() !== '');
    expect(lines).toEqual(['100,100,500,1,0', '100,100,2500,1,0']);
  });

  it('migrates source negative timing points into target alongside hit objects', async () => {
    mockMultipleActiveSections({
      src: makeSectionWithTPs(
        ['500,-50,4,2,1,50,0,0', '1500,-25,4,2,1,50,0,0'],
        ['100,100,500,1,0', '100,100,1500,1,0'],
      ),
      tgt: makeSectionWithTPs([], ['100,100,2500,1,0']),
    });

    await redistributeForMerge({
      difficultyId: 'd', mapsetId: 'm',
      targetSectionId: 'tgt', sourceSectionId: 'src', key: KEY,
    });

    const payload = ul.mock.calls[0][2];
    expect(payload.encrypted_content).toContain('500,-50,4,2,1,50,0,0');
    expect(payload.encrypted_content).toContain('1500,-25,4,2,1,50,0,0');
    expect(payload.encrypted_content).toContain('100,100,500,1,0');
    expect(payload.encrypted_content).toContain('100,100,1500,1,0');
  });

  it('still migrates when source has only negative TPs (no hit objects)', async () => {
    mockMultipleActiveSections({
      src: makeSectionWithTPs(['750,-50,4,2,1,50,0,0'], []),
      tgt: makeSection(['100,100,2500,1,0']),
    });

    await redistributeForMerge({
      difficultyId: 'd', mapsetId: 'm',
      targetSectionId: 'tgt', sourceSectionId: 'src', key: KEY,
    });

    expect(ul).toHaveBeenCalledTimes(1);
    const payload = ul.mock.calls[0][2];
    expect(payload.encrypted_content).toContain('750,-50,4,2,1,50,0,0');
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

  it('migrates source negative timing points into next alongside hit objects', async () => {
    mockMultipleActiveSections({
      src: makeSectionWithTPs(
        ['500,-50,4,2,1,50,0,0'],
        ['100,100,500,1,0'],
      ),
      nxt: makeSection(['100,100,2500,1,0']),
    });

    await redistributeForDelete({
      difficultyId: 'd', mapsetId: 'm',
      deletedSectionId: 'src', nextSectionId: 'nxt', key: KEY,
    });

    const payload = ul.mock.calls[0][2];
    expect(payload.encrypted_content).toContain('500,-50,4,2,1,50,0,0');
    expect(payload.encrypted_content).toContain('100,100,500,1,0');
  });
});
