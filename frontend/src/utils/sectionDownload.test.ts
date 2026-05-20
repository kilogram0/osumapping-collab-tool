import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks must be declared before the import that triggers module evaluation.
const mockDownloadSectionOsu = vi.fn();
const mockDownloadBaseOsu = vi.fn();

vi.mock('../api/endpoints', () => ({
  downloadSectionOsu: (...args: unknown[]) => mockDownloadSectionOsu(...args),
  downloadBaseOsu: (...args: unknown[]) => mockDownloadBaseOsu(...args),
}));

vi.mock('./crypto', () => ({
  decrypt: vi.fn(async (_key: unknown, ciphertext: string) =>
    ciphertext.startsWith('enc:') ? ciphertext.slice(4) : ciphertext,
  ),
  difficultyBaseOsuVersionAad: vi.fn(() => 'base-aad'),
  sectionOsuVersionAad: vi.fn(() => 'section-aad'),
}));

import { assembleSectionOsu } from './sectionDownload';

const FAKE_KEY = {} as CryptoKey;

const BASE_OSU = `osu file format v14

[General]
AudioFilename: audio.mp3

[Metadata]
Title:Song
Artist:Artist
Version:Diff

[TimingPoints]
0,500,4,1,0,100,1,0

[HitObjects]
`;

const SECTION_OSU = `osu file format v14

[Metadata]
Title:Song
Artist:Artist
Version:Diff

[TimingPoints]
1500,-100,4,1,0,80,0,0

[HitObjects]
200,200,1500,1,0,
`;

describe('assembleSectionOsu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges section with active base (happy path)', async () => {
    mockDownloadSectionOsu.mockResolvedValue({
      id: 'sv1',
      encrypted_content: `enc:${SECTION_OSU}`,
      version: 7,
    });
    mockDownloadBaseOsu.mockResolvedValue({
      id: 'bv1',
      encrypted_content: `enc:${BASE_OSU}`,
      version: 3,
    });

    const result = await assembleSectionOsu({
      difficultyId: 'd1',
      sectionId: 's1',
      mapsetId: 'm1',
      key: FAKE_KEY,
      sortOrder: 0,
    });

    expect(result.sectionVersion).toBe(7);
    expect(result.baseVersion).toBe(3);
    // Base's BPM timing point is included.
    expect(result.content).toContain('0,500,4,1,0,100,1,0');
    // Section's hit object is included.
    expect(result.content).toContain('200,200,1500,1,0,');
    // Section's negative timing point is included.
    expect(result.content).toContain('1500,-100,4,1,0,80,0,0');
    // Metadata is exposed.
    expect(result.metadata.artist).toBe('Artist');
    expect(result.metadata.title).toBe('Song');
  });

  it('applies versionOverride to [Metadata] Version', async () => {
    mockDownloadSectionOsu.mockResolvedValue({
      id: 'sv1',
      encrypted_content: `enc:${SECTION_OSU}`,
      version: 2,
    });
    mockDownloadBaseOsu.mockResolvedValue({
      id: 'bv1',
      encrypted_content: `enc:${BASE_OSU}`,
      version: 1,
    });

    const result = await assembleSectionOsu({
      difficultyId: 'd1',
      sectionId: 's1',
      mapsetId: 'm1',
      key: FAKE_KEY,
      versionOverride: 'Intro_version_2',
    });

    expect(result.content).toContain('Version:Intro_version_2');
    expect(result.content).not.toContain('Version:Diff');
    expect(result.metadata.version).toBe('Intro_version_2');
  });

  it('falls back to section content when base download returns 404', async () => {
    mockDownloadSectionOsu.mockResolvedValue({
      id: 'sv1',
      encrypted_content: `enc:${SECTION_OSU}`,
      version: 5,
    });
    // Build an axios-like 404 error.
    const err: Error & { isAxiosError?: boolean; response?: { status: number } } =
      new Error('Not Found');
    err.isAxiosError = true;
    err.response = { status: 404 };
    mockDownloadBaseOsu.mockRejectedValue(err);

    const result = await assembleSectionOsu({
      difficultyId: 'd1',
      sectionId: 's1',
      mapsetId: 'm1',
      key: FAKE_KEY,
    });

    expect(result.sectionVersion).toBe(5);
    expect(result.baseVersion).toBeNull();
    // Without a base, the bare section content is returned (parseable since
    // the fixture is a valid .osu).
    expect(result.content).toContain('200,200,1500,1,0,');
    // No base timing point would be present.
    expect(result.content).not.toContain('0,500,4,1,0,100,1,0');
  });

  it('propagates non-404 errors from base download', async () => {
    mockDownloadSectionOsu.mockResolvedValue({
      id: 'sv1',
      encrypted_content: `enc:${SECTION_OSU}`,
      version: 1,
    });
    const err: Error & { isAxiosError?: boolean; response?: { status: number } } =
      new Error('Server boom');
    err.isAxiosError = true;
    err.response = { status: 500 };
    mockDownloadBaseOsu.mockRejectedValue(err);

    await expect(
      assembleSectionOsu({
        difficultyId: 'd1',
        sectionId: 's1',
        mapsetId: 'm1',
        key: FAKE_KEY,
      }),
    ).rejects.toThrow('Server boom');
  });
});
