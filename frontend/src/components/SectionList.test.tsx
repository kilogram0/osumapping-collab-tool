import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type React from 'react';
import SectionList from './SectionList';
import type { Section } from '../api/endpoints';
import { decrypt } from '../utils/crypto';

const mockIsUnlocked = vi.fn(() => false);
const mockGetKey = vi.fn(async () => null as CryptoKey | null);

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    isUnlocked: mockIsUnlocked,
    getKey: mockGetKey,
    unlockMapset: vi.fn().mockResolvedValue(undefined),
    unlockWithKey: vi.fn().mockResolvedValue(undefined),
    lockMapset: vi.fn().mockResolvedValue(undefined),
    clearAll: vi.fn().mockResolvedValue(undefined),
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
    decodeJsonEnvelope: vi.fn((plaintext: string) => Number(plaintext)),
    sectionFieldAad: vi.fn((sectionId: string, mapsetId: string, field: string) => `sections|${sectionId}|${mapsetId}|${field}`),
  };
});

const SECTIONS: Section[] = [
  {
    id: 's2',
    difficulty_id: 'd1',
    encrypted_name: 'enc:Kiai 1',
    encrypted_start_time_ms: 'enc:30000',
    encrypted_end_time_ms: 'enc:60000',
    encrypted_sort_order: 'enc:1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 's1',
    difficulty_id: 'd1',
    encrypted_name: 'enc:Intro',
    encrypted_start_time_ms: 'enc:0',
    encrypted_end_time_ms: 'enc:30000',
    encrypted_sort_order: 'enc:0',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
];

function renderList(props?: Partial<React.ComponentProps<typeof SectionList>>) {
  return render(
    <SectionList
      sections={SECTIONS}
      mapsetId="ms1"
      {...props}
    />,
  );
}

describe('SectionList', () => {
  beforeEach(() => {
    mockIsUnlocked.mockReturnValue(false);
    mockGetKey.mockResolvedValue(null);
    vi.mocked(decrypt).mockClear();
  });

  it('renders encrypted placeholders when locked', () => {
    renderList();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(screen.getAllByText(/🔒 Encrypted Section/i)).toHaveLength(2);
  });

  it('renders decrypted names and times when unlocked', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    renderList();
    await act(async () => {});
    expect(screen.getByText('Intro')).toBeInTheDocument();
    expect(screen.getByText('Kiai 1')).toBeInTheDocument();
    expect(screen.getByText(/00:00 – 00:30/i)).toBeInTheDocument();
    expect(screen.getByText(/00:30 – 01:00/i)).toBeInTheDocument();
  });

  it('sorts sections by sort order', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    renderList();
    await act(async () => {});
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Intro');
    expect(items[1]).toHaveTextContent('Kiai 1');
  });

  it('shows no-sections message when list is empty', () => {
    renderList({ sections: [] });
    expect(screen.getByText(/No sections yet/i)).toBeInTheDocument();
  });

  it('invokes decrypt with the correct per-field AAD', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    renderList();
    await act(async () => {});
    expect(decrypt).toHaveBeenCalledWith(
      expect.anything(),
      'enc:Intro',
      'sections|s1|ms1|name',
    );
    expect(decrypt).toHaveBeenCalledWith(
      expect.anything(),
      'enc:0',
      'sections|s1|ms1|start_time_ms',
    );
    expect(decrypt).toHaveBeenCalledWith(
      expect.anything(),
      'enc:30000',
      'sections|s1|ms1|end_time_ms',
    );
    expect(decrypt).toHaveBeenCalledWith(
      expect.anything(),
      'enc:0',
      'sections|s1|ms1|sort_order',
    );
  });

  it('falls back to id tiebreaker when sort orders collide', async () => {
    const colliding: Section[] = [
      {
        id: 's-b',
        difficulty_id: 'd1',
        encrypted_name: 'enc:Second',
        encrypted_start_time_ms: 'enc:0',
        encrypted_end_time_ms: 'enc:1000',
        encrypted_sort_order: 'enc:5',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
      {
        id: 's-a',
        difficulty_id: 'd1',
        encrypted_name: 'enc:First',
        encrypted_start_time_ms: 'enc:0',
        encrypted_end_time_ms: 'enc:1000',
        encrypted_sort_order: 'enc:5',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
    ];
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    renderList({ sections: colliding });
    await act(async () => {});
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('First');
    expect(items[1]).toHaveTextContent('Second');
  });

  it('shows failure state when all decrypts fail while unlocked', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    vi.mocked(decrypt).mockRejectedValue(new Error('aad mismatch'));
    renderList();
    await act(async () => {});
    expect(screen.getAllByText(/Failed to decrypt section/i)).toHaveLength(2);
  });
});
