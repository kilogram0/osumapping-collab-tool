import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  useDecryptedMetadata,
  useDecryptedPosts,
  useDecryptedSections,
  useSectionHitObjectScan,
} from './useDecryptedMapset';
import type { DifficultyDetail, Mapset, Section, Post } from '../api/endpoints';
import { decrypt } from '../utils/crypto';

const mockGetKey = vi.fn(async () => ({ key: 'mock-key' } as unknown as CryptoKey));

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    isUnlocked: () => true,
    getKey: mockGetKey,
  }),
}));

vi.mock('../utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/crypto')>();
  return {
    ...actual,
    decrypt: vi.fn(async (_key: CryptoKey, ciphertext: string, _aad: string) => {
      if (ciphertext.startsWith('enc:')) return ciphertext.slice(4);
      return ciphertext;
    }),
    decodeJsonEnvelope: vi.fn((plaintext: string) => {
      try {
        const parsed = JSON.parse(plaintext);
        if (typeof parsed.ms === 'number') return parsed.ms;
        if (typeof parsed.v === 'number') return parsed.v;
      } catch {
        return Number(plaintext);
      }
      return Number(plaintext);
    }),
    mapsetFieldAad: vi.fn((mapsetId: string) => `Mapset|${mapsetId}|${mapsetId}`),
    sectionFieldAad: vi.fn((id: string, mapsetId: string) => `Section|${id}|${mapsetId}`),
    postFieldAad: vi.fn((id: string, mapsetId: string) => `Post|${id}|${mapsetId}`),
    sectionOsuVersionAad: vi.fn((id: string, mapsetId: string) => `SectionOsuVersion|${id}|${mapsetId}`),
  };
});

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/endpoints')>();
  return {
    ...actual,
    downloadSectionOsu: vi.fn().mockRejectedValue(new Error('no osu in tests')),
  };
});

const MOCK_MAPSET: Mapset = {
  id: 'ms1',
  title: 'Test Mapset',
  encrypted_description: 'enc:A test description',
  encrypted_song_length_ms: 'enc:{"v":1,"ms":245000}',
  passphrase_salt: 'salt',
  encrypted_verification: 'enc:verified',
  owner_id: 'owner-uuid',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  delete_at: null,
  allow_keep_on_browser: false,
  difficulty_count: 1,
};

const MOCK_SECTIONS: Section[] = [
  {
    id: 's1',
    difficulty_id: 'd1',
    encrypted_name: 'enc:Intro',
    encrypted_start_time_ms: 'enc:{"v":0,"ms":0}',
    encrypted_end_time_ms: 'enc:{"v":0,"ms":30000}',
    encrypted_sort_order: 'enc:{"v":0,"ms":0}',
    assigned_to: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 's2',
    difficulty_id: 'd1',
    encrypted_name: 'enc:Kiai 1',
    encrypted_start_time_ms: 'enc:{"v":0,"ms":30000}',
    encrypted_end_time_ms: 'enc:{"v":0,"ms":60000}',
    encrypted_sort_order: 'enc:{"v":0,"ms":1}',
    assigned_to: 'user-1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
];

const MOCK_POSTS: Post[] = [
  {
    id: 'p1',
    difficulty_id: 'd1',
    author_id: 'user-1',
    parent_id: null,
    tag: 'suggestion',
    encrypted_body: 'enc:00:46:140 - suggestion',
    created_at: '2024-01-01T12:00:00Z',
    updated_at: '2024-01-01T12:00:00Z',
  },
];

const MOCK_DETAIL: DifficultyDetail = {
  id: 'd1',
  mapset_id: 'ms1',
  encrypted_name: 'enc:Hard',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  delete_at: null,
  sections: MOCK_SECTIONS,
  posts: MOCK_POSTS,
};

const MOCK_SECTIONS_2: Section[] = [
  {
    id: 's3',
    difficulty_id: 'd2',
    encrypted_name: 'enc:Outro',
    encrypted_start_time_ms: 'enc:{"v":0,"ms":60000}',
    encrypted_end_time_ms: 'enc:{"v":0,"ms":90000}',
    encrypted_sort_order: 'enc:{"v":0,"ms":0}',
    assigned_to: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
];

const MOCK_POSTS_2: Post[] = [
  {
    id: 'p2',
    difficulty_id: 'd2',
    author_id: 'user-1',
    parent_id: null,
    tag: 'suggestion',
    encrypted_body: 'enc:01:30:000 - kiai suggestion',
    created_at: '2024-01-01T12:00:00Z',
    updated_at: '2024-01-01T12:00:00Z',
  },
];

const MOCK_DETAIL_2: DifficultyDetail = {
  id: 'd2',
  mapset_id: 'ms1',
  encrypted_name: 'enc:Insane',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  delete_at: null,
  sections: MOCK_SECTIONS_2,
  posts: MOCK_POSTS_2,
};

describe('useDecryptedMetadata', () => {
  beforeEach(() => {
    mockGetKey.mockClear();
  });

  it('returns null values when locked', () => {
    const { result } = renderHook(() => useDecryptedMetadata(MOCK_MAPSET, 'ms1', false));
    expect(result.current.description).toBeNull();
    expect(result.current.songLengthMs).toBeNull();
  });

  it('decrypts description and song length', async () => {
    const { result } = renderHook(() => useDecryptedMetadata(MOCK_MAPSET, 'ms1', true));
    await waitFor(() => expect(result.current.songLengthMs).toBe(245000));
    expect(result.current.description).toBe('A test description');
  });

  it('retries transient decrypt failures instead of caching them', async () => {
    let failOnce = true;
    vi.mocked(decrypt).mockImplementation(async (_key, ciphertext, _aad) => {
      if (ciphertext.includes('245000') && failOnce) {
        failOnce = false;
        throw new Error('transient');
      }
      if (ciphertext.startsWith('enc:')) return ciphertext.slice(4);
      return ciphertext;
    });

    const { result, rerender } = renderHook(
      ({ unlocked }) => useDecryptedMetadata(MOCK_MAPSET, 'ms1', unlocked),
      { initialProps: { unlocked: true } },
    );
    await waitFor(() => expect(result.current.description).toBe('A test description'));
    expect(result.current.songLengthMs).toBeNull();

    rerender({ unlocked: false });
    rerender({ unlocked: true });
    await waitFor(() => expect(result.current.songLengthMs).toBe(245000));

    vi.mocked(decrypt).mockRestore();
  });
});

describe('useDecryptedSections', () => {
  it('derives contiguous start times from sort order', async () => {
    const { result } = renderHook(() => useDecryptedSections(MOCK_DETAIL, 'ms1', true));
    await waitFor(() => expect(result.current.length).toBe(2));
    expect(result.current[0]).toMatchObject({
      id: 's1',
      name: 'Intro',
      startTimeMs: 0,
      endTimeMs: 30000,
      sortOrder: 0,
      assignedTo: null,
    });
    expect(result.current[1]).toMatchObject({
      id: 's2',
      name: 'Kiai 1',
      startTimeMs: 30000,
      endTimeMs: 60000,
      sortOrder: 1,
      assignedTo: 'user-1',
    });
  });

  it('returns empty array when locked', () => {
    const { result } = renderHook(() => useDecryptedSections(MOCK_DETAIL, 'ms1', false));
    expect(result.current).toEqual([]);
  });

  it('reuses cached plaintext when switching back to a previous difficulty', async () => {
    const { result, rerender } = renderHook(
      ({ detail }) => useDecryptedSections(detail, 'ms1', true),
      { initialProps: { detail: MOCK_DETAIL } },
    );
    await waitFor(() => expect(result.current.length).toBe(2));
    const callsAfterD1 = vi.mocked(decrypt).mock.calls.length;

    rerender({ detail: MOCK_DETAIL_2 });
    await waitFor(() => expect(result.current.length).toBe(1));
    const callsAfterD2 = vi.mocked(decrypt).mock.calls.length;
    expect(callsAfterD2).toBeGreaterThan(callsAfterD1);

    rerender({ detail: MOCK_DETAIL });
    await waitFor(() => expect(result.current.length).toBe(2));
    expect(vi.mocked(decrypt).mock.calls.length).toBe(callsAfterD2);
  });
});

describe('useDecryptedPosts', () => {
  it('decrypts post bodies and extracts timestamps', async () => {
    const { result } = renderHook(() => useDecryptedPosts(MOCK_DETAIL, 'ms1', true));
    await waitFor(() => expect(result.current.length).toBe(1));
    expect(result.current[0].decryptedBody).toBe('00:46:140 - suggestion');
    expect(result.current[0].extractedMs).toBe(46140);
  });

  it('reuses cached plaintext when switching back to a previous difficulty', async () => {
    const { result, rerender } = renderHook(
      ({ detail }) => useDecryptedPosts(detail, 'ms1', true),
      { initialProps: { detail: MOCK_DETAIL } },
    );
    await waitFor(() => expect(result.current.length).toBe(1));
    const callsAfterD1 = vi.mocked(decrypt).mock.calls.length;

    rerender({ detail: MOCK_DETAIL_2 });
    await waitFor(() => expect(result.current.length).toBe(1));
    const callsAfterD2 = vi.mocked(decrypt).mock.calls.length;
    expect(callsAfterD2).toBeGreaterThan(callsAfterD1);

    rerender({ detail: MOCK_DETAIL });
    await waitFor(() => expect(result.current.length).toBe(1));
    expect(vi.mocked(decrypt).mock.calls.length).toBe(callsAfterD2);
  });
});

describe('useSectionHitObjectScan', () => {
  it('returns an empty map when there are no sections', () => {
    const { result } = renderHook(() => useSectionHitObjectScan([], 'd1', 'ms1', true));
    expect(result.current.size).toBe(0);
  });

  it('treats failed downloads as no hit objects', async () => {
    const { result } = renderHook(() => useSectionHitObjectScan(
      [{ id: 's1', name: 'Intro', startTimeMs: 0, endTimeMs: 30000, sortOrder: 0, assignedTo: null }],
      'd1',
      'ms1',
      true,
    ));
    await waitFor(() => expect(result.current.get('s1')).toBe(false));
  });
});
