import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/endpoints', () => ({
  downloadBaseOsu: vi.fn(),
  createBaseOsuVersion: vi.fn(),
}));

vi.mock('./crypto', () => ({
  decrypt: vi.fn(async (_key: unknown, ciphertext: string) => ciphertext),
  encrypt: vi.fn(async (_key: unknown, plaintext: string) => plaintext),
  difficultyBaseOsuVersionAad: vi.fn(() => 'base-aad'),
}));

import { syncBaseBookmarks, bookmarksFromSections } from './syncBaseBookmarks';
import { parseOsuFile, parseBookmarks } from './osuParser';
import { downloadBaseOsu, createBaseOsuVersion } from '../api/endpoints';

const mockDownload = vi.mocked(downloadBaseOsu);
const mockCreate = vi.mocked(createBaseOsuVersion);
const KEY = {} as CryptoKey;

function baseWithBookmarks(bookmarks: number[]): string {
  return `osu file format v14

[General]
AudioFilename: audio.mp3

[Editor]
Bookmarks: ${bookmarks.join(',')}

[TimingPoints]
0,500,4,2,1,50,1,0

[HitObjects]

`;
}

function sections(...endTimes: number[]) {
  return endTimes.map((endTimeMs, i) => ({ id: `s${i}`, sortOrder: i, endTimeMs }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({} as never);
});

describe('bookmarksFromSections', () => {
  it('returns interior boundaries (every end except the last), sorted and deduped', () => {
    expect(bookmarksFromSections(sections(1000, 2000, 4000))).toEqual([1000, 2000]);
  });

  it('returns no bookmarks for a single section', () => {
    expect(bookmarksFromSections(sections(4000))).toEqual([]);
  });

  it('orders by sortOrder before taking boundaries, not array order', () => {
    const unordered = [
      { id: 'b', sortOrder: 2, endTimeMs: 4000 },
      { id: 'a', sortOrder: 0, endTimeMs: 1000 },
      { id: 'm', sortOrder: 1, endTimeMs: 2000 },
    ];
    expect(bookmarksFromSections(unordered)).toEqual([1000, 2000]);
  });
});

describe('syncBaseBookmarks', () => {
  it('uploads a new base version with the divisions when they differ', async () => {
    mockDownload.mockResolvedValue({ id: 'base-1', encrypted_content: baseWithBookmarks([500]) } as never);

    const changed = await syncBaseBookmarks({
      difficultyId: 'd1',
      mapsetId: 'ms1',
      key: KEY,
      sections: sections(1000, 2000, 4000),
    });

    expect(changed).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // encrypt is mocked passthrough, so encrypted_content is the new plaintext.
    const payload = mockCreate.mock.calls[0][1];
    expect(parseBookmarks(parseOsuFile(payload.encrypted_content))).toEqual([1000, 2000]);
  });

  it('is a no-op when the base bookmarks already match the divisions', async () => {
    mockDownload.mockResolvedValue({ id: 'base-1', encrypted_content: baseWithBookmarks([1000, 2000]) } as never);

    const changed = await syncBaseBookmarks({
      difficultyId: 'd1',
      mapsetId: 'ms1',
      key: KEY,
      sections: sections(1000, 2000, 4000),
    });

    expect(changed).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
