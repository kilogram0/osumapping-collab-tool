import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DifficultyTabs from './DifficultyTabs';

const mockIsUnlocked = vi.fn(() => false);
const mockGetKey = vi.fn(async () => null as CryptoKey | null);

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    isUnlocked: mockIsUnlocked,
    getKey: mockGetKey,
    unlockMapset: vi.fn(),
    unlockWithKey: vi.fn(),
    lockMapset: vi.fn(),
    clearAll: vi.fn(),
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
    difficultyFieldAad: vi.fn((difficultyId: string, mapsetId: string) => `Difficulty|${difficultyId}|${mapsetId}`),
  };
});

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

const DIFFICULTIES = [
  { id: 'd1', mapset_id: 'ms1', encrypted_name: 'enc:Easy', created_at: '', updated_at: '' },
  { id: 'd2', mapset_id: 'ms1', encrypted_name: 'enc:Hard', created_at: '', updated_at: '' },
];

describe('DifficultyTabs', () => {
  beforeEach(() => {
    mockIsUnlocked.mockReturnValue(false);
    mockGetKey.mockResolvedValue(null);
  });

  it('renders locked placeholders when not unlocked', () => {
    render(<DifficultyTabs difficulties={DIFFICULTIES} selectedId="d1" onSelect={vi.fn()} mapsetId="ms1" />);
    expect(screen.getAllByText(/🔒 Encrypted Difficulty/i)).toHaveLength(2);
  });

  it('renders decrypted names when unlocked', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    render(<DifficultyTabs difficulties={DIFFICULTIES} selectedId="d1" onSelect={vi.fn()} mapsetId="ms1" />);
    await act(async () => {});
    expect(screen.getByText('Easy')).toBeInTheDocument();
    expect(screen.getByText('Hard')).toBeInTheDocument();
  });

  it('calls onSelect when a tab is clicked', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    const onSelect = vi.fn();
    render(<DifficultyTabs difficulties={DIFFICULTIES} selectedId="d1" onSelect={onSelect} mapsetId="ms1" />);
    await act(async () => {});
    const hardTab = screen.getByRole('tab', { name: 'Hard' });
    hardTab.click();
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith('d2');
    });
  });
});
