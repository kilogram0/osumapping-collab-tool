import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type React from 'react';
import DifficultyTabs from './DifficultyTabs';
import type { Difficulty } from '../api/endpoints';
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
    difficultyFieldAad: vi.fn((difficultyId: string, mapsetId: string, field: string) => `difficulties|${difficultyId}|${mapsetId}|${field}`),
  };
});

const DIFFICULTIES: Difficulty[] = [
  { id: 'd1', mapset_id: 'ms1', encrypted_name: 'enc:Easy', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
  { id: 'd2', mapset_id: 'ms1', encrypted_name: 'enc:Hard', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
];

function renderTabs(props?: Partial<React.ComponentProps<typeof DifficultyTabs>>) {
  return render(
    <DifficultyTabs
      difficulties={DIFFICULTIES}
      selectedId={null}
      onSelect={vi.fn()}
      mapsetId="ms1"
      {...props}
    />,
  );
}

describe('DifficultyTabs', () => {
  beforeEach(() => {
    mockIsUnlocked.mockReturnValue(false);
    mockGetKey.mockResolvedValue(null);
    vi.mocked(decrypt).mockClear();
  });

  it('renders encrypted placeholders when locked', () => {
    renderTabs();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs.every((t) => t.textContent?.includes('🔒 Encrypted Difficulty'))).toBe(true);
  });

  it('renders decrypted names when unlocked', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    renderTabs();
    await act(async () => {});
    expect(screen.getByRole('tab', { name: 'Easy' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Hard' })).toBeInTheDocument();
  });

  it('calls onSelect when a tab is clicked', async () => {
    const onSelect = vi.fn();
    renderTabs({ onSelect });
    await userEvent.click(screen.getAllByRole('tab')[0]);
    expect(onSelect).toHaveBeenCalledWith('d1');
  });

  it('shows no-difficulties message when list is empty', () => {
    renderTabs({ difficulties: [] });
    expect(screen.getByText(/No difficulties yet/i)).toBeInTheDocument();
  });

  it('marks the selected tab as aria-selected', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    renderTabs({ selectedId: 'd2' });
    await act(async () => {});
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('invokes decrypt with the correct per-field AAD', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    renderTabs();
    await act(async () => {});
    expect(decrypt).toHaveBeenCalledWith(
      expect.anything(),
      'enc:Easy',
      'difficulties|d1|ms1|name',
    );
    expect(decrypt).toHaveBeenCalledWith(
      expect.anything(),
      'enc:Hard',
      'difficulties|d2|ms1|name',
    );
  });

  it('renders placeholder for a difficulty whose decrypt fails', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    vi.mocked(decrypt).mockImplementation(async (_key, ciphertext) => {
      if (ciphertext === 'enc:Easy') throw new Error('aad mismatch');
      if (ciphertext.startsWith('enc:')) return ciphertext.slice(4);
      return ciphertext;
    });
    renderTabs();
    await act(async () => {});
    expect(screen.getByRole('tab', { name: 'Hard' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });
});
