import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DifficultyDropdown from './DifficultyDropdown';
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
    decrypt: vi.fn(async (_key: CryptoKey, ciphertext: string, _aad: string) =>
      ciphertext.startsWith('enc:') ? ciphertext.slice(4) : ciphertext,
    ),
    difficultyFieldAad: vi.fn((d: string, m: string) => `Difficulty|${d}|${m}`),
  };
});

vi.mock('../utils/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

function diff(id: string, name: string, deleteAt: string | null = null): Difficulty {
  return {
    id,
    mapset_id: 'ms1',
    encrypted_name: `enc:${name}`,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    delete_at: deleteAt,
  };
}

const ACTIVE = [diff('d1', 'Easy'), diff('d2', 'Hard')];

function setup(overrides: Partial<React.ComponentProps<typeof DifficultyDropdown>> = {}) {
  const props = {
    activeDifficulties: ACTIVE,
    pendingDifficulties: [] as Difficulty[],
    selectedId: 'd1',
    onSelect: vi.fn(),
    mapsetId: 'ms1',
    canAdd: true,
    isOwner: true,
    onAddDifficulty: vi.fn(),
    onRenameDifficulty: vi.fn(),
    onDeleteDifficulty: vi.fn(),
    onRestoreDifficulty: vi.fn(),
    onDownloadDifficulty: vi.fn(),
    restoringId: null,
    downloadingId: null,
    ...overrides,
  };
  render(<DifficultyDropdown {...props} />);
  return props;
}

describe('DifficultyDropdown', () => {
  beforeEach(() => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
  });

  it('shows the selected difficulty name on the trigger when unlocked', async () => {
    setup();
    await act(async () => {});
    expect(screen.getByText('Easy')).toBeInTheDocument();
  });

  it('shows the encrypted placeholder on the trigger when locked', () => {
    mockIsUnlocked.mockReturnValue(false);
    setup();
    expect(screen.getByText(/🔒 Encrypted Difficulty/i)).toBeInTheDocument();
  });

  it('opens the panel and lists active difficulties as options', async () => {
    setup();
    await act(async () => {});
    await userEvent.click(screen.getByRole('button', { name: /Toggle difficulty list/i }));
    expect(screen.getByRole('option', { name: 'Easy' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Hard' })).toBeInTheDocument();
  });

  it('calls onSelect and closes when an option is clicked', async () => {
    const props = setup();
    await act(async () => {});
    await userEvent.click(screen.getByRole('button', { name: /Toggle difficulty list/i }));
    await userEvent.click(screen.getByRole('option', { name: 'Hard' }));
    expect(props.onSelect).toHaveBeenCalledWith('d2');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows the Add Difficulty option only when canAdd is true', async () => {
    const props = setup({ canAdd: true });
    await act(async () => {});
    await userEvent.click(screen.getByRole('button', { name: /Toggle difficulty list/i }));
    const addBtn = screen.getByRole('button', { name: /\(Add Difficulty\)/i });
    await userEvent.click(addBtn);
    expect(props.onAddDifficulty).toHaveBeenCalled();
  });

  it('hides the Add Difficulty option when canAdd is false', async () => {
    setup({ canAdd: false });
    await act(async () => {});
    await userEvent.click(screen.getByRole('button', { name: /Toggle difficulty list/i }));
    expect(screen.queryByRole('button', { name: /\(Add Difficulty\)/i })).not.toBeInTheDocument();
  });

  it('renders rename/delete icons per row for owners and passes id + name', async () => {
    const props = setup({ isOwner: true });
    await act(async () => {});
    const toggle = screen.getByRole('button', { name: /Toggle difficulty list/i });
    // Rename/delete close the menu (they open a modal), so reopen between clicks.
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: /Rename Difficulty: Hard/i }));
    expect(props.onRenameDifficulty).toHaveBeenCalledWith('d2', 'Hard');
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: /Delete Difficulty: Easy/i }));
    expect(props.onDeleteDifficulty).toHaveBeenCalledWith('d1', 'Easy');
  });

  it('disables rename/delete while locked (no decrypted name)', async () => {
    mockIsUnlocked.mockReturnValue(false);
    const props = setup({ isOwner: true });
    await act(async () => {});
    await userEvent.click(screen.getByRole('button', { name: /Toggle difficulty list/i }));
    const renameButtons = screen.getAllByRole('button', { name: /Rename Difficulty/i });
    const deleteButtons = screen.getAllByRole('button', { name: /Delete Difficulty/i });
    renameButtons.forEach((b) => expect(b).toBeDisabled());
    deleteButtons.forEach((b) => expect(b).toBeDisabled());
    await userEvent.click(renameButtons[0]);
    await userEvent.click(deleteButtons[0]);
    expect(props.onRenameDifficulty).not.toHaveBeenCalled();
    expect(props.onDeleteDifficulty).not.toHaveBeenCalled();
  });

  it('hides rename/delete icons for non-owners', async () => {
    setup({ isOwner: false });
    await act(async () => {});
    await userEvent.click(screen.getByRole('button', { name: /Toggle difficulty list/i }));
    expect(screen.queryByRole('button', { name: /Rename Difficulty/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete Difficulty/i })).not.toBeInTheDocument();
  });

  it('lists deleted difficulties with restore/download for owners', async () => {
    const props = setup({ pendingDifficulties: [diff('d9', 'Insane', '2024-02-01T00:00:00Z')] });
    await act(async () => {});
    await userEvent.click(screen.getByRole('button', { name: /Toggle difficulty list/i }));
    expect(screen.getByText('Insane')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Restore: Insane/i }));
    expect(props.onRestoreDifficulty).toHaveBeenCalledWith('d9');
    await userEvent.click(screen.getByRole('button', { name: /Download .osu: Insane/i }));
    expect(props.onDownloadDifficulty).toHaveBeenCalledWith('d9', 'Insane');
  });

  it('shows days remaining until purge next to a deleted difficulty', async () => {
    const future = new Date(Date.now() + 4 * 86_400_000 + 60_000).toISOString();
    setup({ pendingDifficulties: [diff('d9', 'Insane', future)] });
    await act(async () => {});
    await userEvent.click(screen.getByRole('button', { name: /Toggle difficulty list/i }));
    expect(screen.getByText(/Expires in 5 days/i)).toBeInTheDocument();
  });

  it('hides deleted difficulties from non-owners', async () => {
    setup({ isOwner: false, pendingDifficulties: [diff('d9', 'Insane', '2024-02-01T00:00:00Z')] });
    await act(async () => {});
    await userEvent.click(screen.getByRole('button', { name: /Toggle difficulty list/i }));
    expect(screen.queryByText('Insane')).not.toBeInTheDocument();
  });

  it('closes the panel on outside click', async () => {
    setup();
    await act(async () => {});
    await userEvent.click(screen.getByRole('button', { name: /Toggle difficulty list/i }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.click(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
