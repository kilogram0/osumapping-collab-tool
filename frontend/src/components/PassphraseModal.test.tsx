import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PassphraseModal from './PassphraseModal';
import type { Mapset } from '../api/endpoints';

const mockUnlockMapset = vi.fn();

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    unlockMapset: mockUnlockMapset,
    unlockWithKey: vi.fn().mockResolvedValue(undefined),
    tryAutoUnlock: vi.fn().mockResolvedValue(false),
    getKey: vi.fn().mockResolvedValue(null),
    lockMapset: vi.fn().mockResolvedValue(undefined),
    clearAll: vi.fn().mockResolvedValue(undefined),
    isUnlocked: vi.fn(() => false),
    isPersisted: vi.fn(() => false),
  }),
}));

const BASE_MAPSET: Mapset = {
  id: 'test-mapset-id',
  title: 'Test Mapset',
  encrypted_description: null,
  encrypted_song_length_ms: 'encrypted:0',
  passphrase_salt: 'c2FsdA==',
  encrypted_verification: 'encrypted:verified',
  owner_id: 'owner-uuid',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  delete_at: null,
  allow_keep_on_browser: false,
  difficulty_count: 0,
};

describe('PassphraseModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the modal with title and passphrase input', () => {
    render(<PassphraseModal mapset={BASE_MAPSET} onSuccess={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Unlock Mapset')).toBeInTheDocument();
    expect(screen.getByLabelText(/passphrase/i)).toBeInTheDocument();
  });

  it('calls onSuccess when unlockMapset resolves', async () => {
    mockUnlockMapset.mockResolvedValueOnce(undefined);
    const onSuccess = vi.fn();
    render(<PassphraseModal mapset={BASE_MAPSET} onSuccess={onSuccess} />);

    await userEvent.type(screen.getByLabelText(/passphrase/i), 'correct-passphrase');
    await userEvent.click(screen.getByRole('button', { name: /unlock$/i }));

    expect(mockUnlockMapset).toHaveBeenCalledWith(
      BASE_MAPSET.id,
      'correct-passphrase',
      BASE_MAPSET.passphrase_salt,
      BASE_MAPSET.encrypted_verification,
      { persist: false },
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it('shows an error message when unlockMapset rejects (wrong passphrase)', async () => {
    mockUnlockMapset.mockRejectedValueOnce(new Error('bad passphrase'));
    render(<PassphraseModal mapset={BASE_MAPSET} onSuccess={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/passphrase/i), 'wrong-passphrase');
    await userEvent.click(screen.getByRole('button', { name: /unlock$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect passphrase/i);
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    render(<PassphraseModal mapset={BASE_MAPSET} onSuccess={vi.fn()} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables the Unlock button when passphrase is empty', () => {
    render(<PassphraseModal mapset={BASE_MAPSET} onSuccess={vi.fn()} />);
    expect(screen.getByRole('button', { name: /unlock$/i })).toBeDisabled();
  });

  it('does not show the keep-on-browser option when the mapset forbids it', () => {
    render(<PassphraseModal mapset={BASE_MAPSET} onSuccess={vi.fn()} />);
    expect(screen.queryByLabelText(/remember this passphrase/i)).not.toBeInTheDocument();
  });

  it('shows the keep-on-browser option when the mapset allows it', () => {
    render(<PassphraseModal mapset={{ ...BASE_MAPSET, allow_keep_on_browser: true }} onSuccess={vi.fn()} />);
    expect(screen.getByLabelText(/remember this passphrase/i)).toBeInTheDocument();
  });

  it('persists the passphrase when the keep-on-browser checkbox is checked', async () => {
    mockUnlockMapset.mockResolvedValueOnce(undefined);
    render(<PassphraseModal mapset={{ ...BASE_MAPSET, allow_keep_on_browser: true }} onSuccess={vi.fn()} />);

    await userEvent.type(screen.getByPlaceholderText(/enter mapset passphrase/i), 'correct-passphrase');
    await userEvent.click(screen.getByLabelText(/remember this passphrase/i));
    await userEvent.click(screen.getByRole('button', { name: /unlock$/i }));

    expect(mockUnlockMapset).toHaveBeenCalledWith(
      BASE_MAPSET.id,
      'correct-passphrase',
      BASE_MAPSET.passphrase_salt,
      BASE_MAPSET.encrypted_verification,
      { persist: true },
    );
  });
});
