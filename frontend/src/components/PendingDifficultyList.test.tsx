import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PendingDifficultyList from './PendingDifficultyList';
import type { Difficulty } from '../api/endpoints';

const mockIsUnlocked = vi.fn(() => true);
const mockGetKey = vi.fn(async () => ({} as CryptoKey));

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
    difficultyFieldAad: vi.fn(
      (difficultyId: string, mapsetId: string) => `Difficulty|${difficultyId}|${mapsetId}`,
    ),
  };
});

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

function diff(id: string, deleteAtMs: number): Difficulty {
  return {
    id,
    mapset_id: 'ms1',
    encrypted_name: `enc:${id.toUpperCase()}`,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    delete_at: new Date(deleteAtMs).toISOString(),
  };
}

describe('PendingDifficultyList', () => {
  beforeEach(() => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
  });

  it('shows the empty-state message when there are no pending difficulties', () => {
    render(
      <PendingDifficultyList
        difficulties={[]}
        mapsetId="ms1"
        onRestore={vi.fn()}
        restoringId={null}
      />,
    );
    expect(screen.getByText(/No difficulties pending deletion/i)).toBeInTheDocument();
  });

  it('renders decrypted names with strikethrough and a Restore button', async () => {
    render(
      <PendingDifficultyList
        difficulties={[diff('d1', Date.now() + 3 * 86_400_000)]}
        mapsetId="ms1"
        onRestore={vi.fn()}
        restoringId={null}
      />,
    );
    await act(async () => {});
    const label = screen.getByText('D1');
    expect(label).toHaveClass('line-through');
    expect(screen.getByRole('button', { name: /Restore/i })).toBeInTheDocument();
  });

  it('displays days until expiration', async () => {
    render(
      <PendingDifficultyList
        difficulties={[diff('d1', Date.now() + 4 * 86_400_000 + 60_000)]}
        mapsetId="ms1"
        onRestore={vi.fn()}
        restoringId={null}
      />,
    );
    await act(async () => {});
    expect(screen.getByText(/Expires in 5 days/i)).toBeInTheDocument();
  });

  it('invokes onRestore with the difficulty id when Restore is clicked', async () => {
    const onRestore = vi.fn();
    render(
      <PendingDifficultyList
        difficulties={[diff('d1', Date.now() + 86_400_000)]}
        mapsetId="ms1"
        onRestore={onRestore}
        restoringId={null}
      />,
    );
    await act(async () => {});
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Restore/i }));
    expect(onRestore).toHaveBeenCalledWith('d1');
  });

  it('shows a loading label and disables the button while restoring', async () => {
    render(
      <PendingDifficultyList
        difficulties={[diff('d1', Date.now() + 86_400_000)]}
        mapsetId="ms1"
        onRestore={vi.fn()}
        restoringId="d1"
      />,
    );
    await act(async () => {});
    const button = screen.getByRole('button', { name: /Restoring…/i });
    expect(button).toBeDisabled();
  });
});
