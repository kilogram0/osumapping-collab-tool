import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/endpoints', () => ({
  createSection: vi.fn(),
  uploadSectionOsu: vi.fn(),
  deleteSection: vi.fn(),
}));

vi.mock('./crypto', () => ({
  encrypt: vi.fn(async (_key: unknown, plaintext: string) => plaintext),
  sectionFieldAad: vi.fn(() => 'field-aad'),
  sectionOsuVersionAad: vi.fn(() => 'version-aad'),
  difficultyBaseOsuVersionAad: vi.fn(() => 'base-aad'),
}));

vi.mock('./sectionDownload', () => ({
  assembleFullOsu: vi.fn(),
}));

import { resectionFromBookmarks } from './resectionFromBookmarks';
import { parseOsuFile, parseBookmarks } from './osuParser';
import { createSection, uploadSectionOsu, deleteSection } from '../api/endpoints';
import { assembleFullOsu } from './sectionDownload';

const mockCreate = vi.mocked(createSection);
const mockUpload = vi.mocked(uploadSectionOsu);
const mockDelete = vi.mocked(deleteSection);
const mockAssemble = vi.mocked(assembleFullOsu);

const KEY = {} as CryptoKey;

/** A full-song .osu with hit objects spread across the timeline, used as the
 *  assembled content the re-section slices apart. */
const ASSEMBLED = `osu file format v14

[General]
AudioFilename: audio.mp3

[TimingPoints]
0,500,4,2,1,50,1,0

[HitObjects]
256,192,500,1,0
256,192,1500,1,0
256,192,2500,1,0
256,192,3500,1,0
`;

/** The decrypted base plaintext the assembler returns — carries stale
 *  bookmarks that the re-section should overwrite with the new divisions. */
const BASE_PLAINTEXT = `osu file format v14

[General]
AudioFilename: audio.mp3

[Editor]
Bookmarks: 500

[TimingPoints]
0,500,4,2,1,50,1,0

[HitObjects]

`;

function osuWithBookmarks(bookmarks: number[]): ReturnType<typeof parseOsuFile> {
  const text = `osu file format v14

[General]
AudioFilename: audio.mp3

[Editor]
Bookmarks: ${bookmarks.join(',')}

[HitObjects]
256,192,500,1,0
`;
  return parseOsuFile(text);
}

function existing(ids: string[]) {
  return ids.map((id, i) => ({ id, sortOrder: i, endTimeMs: (i + 1) * 1000 }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({} as never);
  mockUpload.mockResolvedValue({} as never);
  mockDelete.mockResolvedValue(undefined);
  mockAssemble.mockResolvedValue({ content: ASSEMBLED, basePlaintext: BASE_PLAINTEXT, baseVersion: 1 });
});

describe('resectionFromBookmarks', () => {
  it('rebuilds sections from bookmarks and deletes the old ones', async () => {
    const result = await resectionFromBookmarks({
      parsed: osuWithBookmarks([1000, 2000, 3000]),
      key: KEY,
      mapsetId: 'ms1',
      difficultyId: 'd1',
      songLengthMs: 4000,
      existingSections: existing(['old-a', 'old-b']),
    });

    // Boundaries: [0,1000],[1000,2000],[2000,3000],[3000,4000] → 4 sections.
    expect(result).toEqual({ created: 4, total: 4, deleted: 2, error: null });
    expect(mockCreate).toHaveBeenCalledTimes(4);
    expect(mockUpload).toHaveBeenCalledTimes(4);
    expect(mockDelete).toHaveBeenCalledTimes(2);
    expect(mockDelete).toHaveBeenCalledWith('d1', 'old-a');
    expect(mockDelete).toHaveBeenCalledWith('d1', 'old-b');
  });

  it('rebuilds the base with the new bookmarks and bundles it on the first upload only', async () => {
    await resectionFromBookmarks({
      parsed: osuWithBookmarks([1000, 2000, 3000]),
      key: KEY,
      mapsetId: 'ms1',
      difficultyId: 'd1',
      songLengthMs: 4000,
      existingSections: existing(['old-a']),
    });

    // encrypt() is mocked to passthrough, so base_version.encrypted_content is
    // the rebuilt base plaintext. Its bookmarks should be the new divisions
    // (1000,2000,3000), not the stale 500 from BASE_PLAINTEXT.
    const firstPayload = mockUpload.mock.calls[0][2];
    expect(firstPayload.base_version).toBeTruthy();
    expect(parseBookmarks(parseOsuFile(firstPayload.base_version!.encrypted_content))).toEqual([1000, 2000, 3000]);

    // Later uploads must NOT re-bundle a base.
    for (const call of mockUpload.mock.calls.slice(1)) {
      expect(call[2].base_version).toBeNull();
    }
  });

  it('drops bookmarks closer than 1s before deriving sections', async () => {
    const result = await resectionFromBookmarks({
      parsed: osuWithBookmarks([1000, 1100, 2200]),
      key: KEY,
      mapsetId: 'ms1',
      difficultyId: 'd1',
      songLengthMs: 4000,
      existingSections: existing(['old-a']),
    });

    // 1100 is within 1s of 1000 → dropped. Kept: 1000, 2200.
    // Boundaries: [0,1000],[1000,2200],[2200,4000] → 3 sections.
    expect(result.created).toBe(3);
    expect(result.total).toBe(3);
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('creates and populates new sections before deleting old ones (no data loss window)', async () => {
    const order: string[] = [];
    mockCreate.mockImplementation(async () => { order.push('create'); return {} as never; });
    mockUpload.mockImplementation(async () => { order.push('upload'); return {} as never; });
    mockDelete.mockImplementation(async () => { order.push('delete'); });

    await resectionFromBookmarks({
      parsed: osuWithBookmarks([2000]),
      key: KEY,
      mapsetId: 'ms1',
      difficultyId: 'd1',
      songLengthMs: 4000,
      existingSections: existing(['old-a']),
    });

    const firstDelete = order.indexOf('delete');
    const lastWrite = Math.max(order.lastIndexOf('create'), order.lastIndexOf('upload'));
    expect(firstDelete).toBeGreaterThan(lastWrite);
  });

  it('errors without mutating when the file has no bookmarks', async () => {
    const result = await resectionFromBookmarks({
      parsed: osuWithBookmarks([]),
      key: KEY,
      mapsetId: 'ms1',
      difficultyId: 'd1',
      songLengthMs: 4000,
      existingSections: existing(['old-a']),
    });

    expect(result.error).toMatch(/no bookmarks/i);
    expect(result.created).toBe(0);
    expect(mockAssemble).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('aborts before any mutation when assembly fails', async () => {
    mockAssemble.mockRejectedValue(new Error('base 404'));

    const result = await resectionFromBookmarks({
      parsed: osuWithBookmarks([2000]),
      key: KEY,
      mapsetId: 'ms1',
      difficultyId: 'd1',
      songLengthMs: 4000,
      existingSections: existing(['old-a']),
    });

    expect(result.error).toMatch(/base 404/);
    expect(result.created).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('reports a partial failure when an old section will not delete (data already rebuilt)', async () => {
    mockDelete.mockRejectedValueOnce(new Error('conflict'));

    const result = await resectionFromBookmarks({
      parsed: osuWithBookmarks([2000]),
      key: KEY,
      mapsetId: 'ms1',
      difficultyId: 'd1',
      songLengthMs: 4000,
      existingSections: existing(['old-a', 'old-b']),
    });

    // Boundaries: [0,2000],[2000,4000] → 2 created; first delete fails.
    expect(result.created).toBe(2);
    expect(result.deleted).toBe(0);
    expect(result.error).toMatch(/failed to remove an old one/i);
  });
});
