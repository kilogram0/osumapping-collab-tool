import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import PassphraseModal from './PassphraseModal';
import type { Mapset } from '../api/endpoints';

const mockUnlockMapset = vi.fn();

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    unlockMapset: mockUnlockMapset,
    unlockWithKey: vi.fn().mockResolvedValue(undefined),
    getKey: vi.fn().mockResolvedValue(null),
    lockMapset: vi.fn().mockResolvedValue(undefined),
    clearAll: vi.fn().mockResolvedValue(undefined),
    isUnlocked: vi.fn(() => false),
  }),
}));

const MAPSET: Mapset = {
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
  difficulty_count: 0,
};

describe('PassphraseModal', () => {
  it('renders the modal with title and passphrase input', () => {
    render(<PassphraseModal mapset={MAPSET} onSuccess={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Unlock Mapset')).toBeInTheDocument();
    expect(screen.getByLabelText(/passphrase/i)).toBeInTheDocument();
  });

  it('calls onSuccess when unlockMapset resolves', async () => {
    mockUnlockMapset.mockResolvedValueOnce(undefined);
    const onSuccess = vi.fn();
    render(<PassphraseModal mapset={MAPSET} onSuccess={onSuccess} />);

    await userEvent.type(screen.getByLabelText(/passphrase/i), 'correct-passphrase');
    await userEvent.click(screen.getByRole('button', { name: /unlock$/i }));

    expect(mockUnlockMapset).toHaveBeenCalledWith(
      MAPSET.id,
      'correct-passphrase',
      MAPSET.passphrase_salt,
      MAPSET.encrypted_verification,
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it('shows an error message when unlockMapset rejects (wrong passphrase)', async () => {
    mockUnlockMapset.mockRejectedValueOnce(new Error('bad passphrase'));
    render(<PassphraseModal mapset={MAPSET} onSuccess={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/passphrase/i), 'wrong-passphrase');
    await userEvent.click(screen.getByRole('button', { name: /unlock$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect passphrase/i);
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    render(<PassphraseModal mapset={MAPSET} onSuccess={vi.fn()} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables the Unlock button when passphrase is empty', () => {
    render(<PassphraseModal mapset={MAPSET} onSuccess={vi.fn()} />);
    expect(screen.getByRole('button', { name: /unlock$/i })).toBeDisabled();
  });
});
