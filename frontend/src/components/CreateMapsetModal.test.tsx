import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CreateMapsetModal from './CreateMapsetModal';
import { encrypt } from '../utils/crypto';
import { createMapset } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  createMapset: vi.fn().mockResolvedValue({
    id: 'test-mapset-id',
    title: 'Test Mapset',
    encrypted_description: null,
    encrypted_song_length_ms: 'encrypted-mock',
    passphrase_salt: 'mock-salt',
    encrypted_verification: 'encrypted-verification',
    owner_id: 'owner-uuid',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }),
  fetchMapsets: vi.fn().mockResolvedValue([]),
  fetchMapset: vi.fn().mockResolvedValue(null),
}));

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    unlockWithKey: vi.fn().mockResolvedValue(undefined),
    isUnlocked: vi.fn(() => false),
    getKey: vi.fn().mockResolvedValue(null),
    unlockMapset: vi.fn().mockResolvedValue(undefined),
    lockMapset: vi.fn().mockResolvedValue(undefined),
    clearAll: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../utils/crypto', () => ({
  generatePassphrase: () => 'mock-passphrase-mock-passphrase-mock-passphrase',
  generateSalt: () => 'mock-salt',
  deriveKey: vi.fn().mockResolvedValue({} as CryptoKey),
  encrypt: vi.fn().mockResolvedValue('encrypted-mock'),
  mapsetFieldAad: vi.fn().mockReturnValue('Mapset|id|id'),
  mapsetVerificationAad: vi.fn().mockReturnValue('Mapset|id|id'),
  VERIFICATION_CANARY: 'verified',
}));

function renderModal() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CreateMapsetModal onSuccess={vi.fn()} onCancel={vi.fn()} />
    </QueryClientProvider>,
  );
}

async function fillAndSubmit(title: string) {
  await userEvent.type(screen.getByLabelText(/title/i), title);
  await userEvent.click(screen.getByRole('checkbox', { name: /saved this passphrase/i }));
  await userEvent.click(screen.getByRole('button', { name: /create mapset/i }));
  await waitFor(() => {
    expect(vi.mocked(createMapset)).toHaveBeenCalled();
  });
}

describe('CreateMapsetModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders minutes and seconds inputs', () => {
    renderModal();
    expect(screen.getByLabelText(/minutes/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/seconds/i)).toBeInTheDocument();
  });

  it('submits with correct total milliseconds from minutes and seconds', async () => {
    renderModal();
    await userEvent.type(screen.getByLabelText(/minutes/i), '3');
    await userEvent.type(screen.getByLabelText(/seconds/i), '30');
    await fillAndSubmit('Test Mapset');

    const songLengthCall = vi.mocked(encrypt).mock.calls.find(
      (call) => call[1] === '{"v":1,"ms":210000}',
    );
    expect(songLengthCall).toBeDefined();
  });

  it('defaults to 0 ms when minutes and seconds are empty', async () => {
    renderModal();
    await fillAndSubmit('Test Mapset');

    const songLengthCall = vi.mocked(encrypt).mock.calls.find(
      (call) => call[1] === '{"v":1,"ms":0}',
    );
    expect(songLengthCall).toBeDefined();
  });

  it('clamps seconds to 59', async () => {
    renderModal();
    const secondsInput = screen.getByLabelText(/seconds/i) as HTMLInputElement;
    await userEvent.clear(secondsInput);
    await userEvent.type(secondsInput, '75');
    expect(secondsInput.value).toBe('59');
  });

  it('does not clamp large minute values', async () => {
    renderModal();
    const minutesInput = screen.getByLabelText(/minutes/i) as HTMLInputElement;
    await userEvent.clear(minutesInput);
    await userEvent.type(minutesInput, '150');
    expect(minutesInput.value).toBe('150');
  });

  it('rejects negative values by clamping to 0', async () => {
    renderModal();
    const minutesInput = screen.getByLabelText(/minutes/i) as HTMLInputElement;
    await userEvent.clear(minutesInput);
    await userEvent.type(minutesInput, '-5');
    expect(minutesInput.value).toBe('0');
  });

  it('does not submit without title', async () => {
    renderModal();
    await userEvent.click(screen.getByRole('checkbox', { name: /saved this passphrase/i }));
    await userEvent.click(screen.getByRole('button', { name: /create mapset/i }));

    expect(vi.mocked(createMapset)).not.toHaveBeenCalled();
  });

  it('does not submit without passphrase confirmation', async () => {
    renderModal();
    await userEvent.type(screen.getByLabelText(/title/i), 'Test Mapset');
    await userEvent.click(screen.getByRole('button', { name: /create mapset/i }));

    expect(vi.mocked(createMapset)).not.toHaveBeenCalled();
  });
});
