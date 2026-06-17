import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import EditMapsetModal from './EditMapsetModal';
import { updateMapset } from '../api/endpoints';
import { ToastProvider } from '../contexts/ToastContext';

vi.mock('../api/endpoints', () => ({
  updateMapset: vi.fn().mockResolvedValue({
    id: 'test-mapset-id',
    title: 'Updated Title',
    encrypted_description: 'encrypted-mock',
    encrypted_song_length_ms: 'encrypted-mock',
    passphrase_salt: 'mock-salt',
    encrypted_verification: 'encrypted-verification',
    allow_keep_on_browser: false,
    owner_id: 'owner-uuid',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }),
  fetchMapsets: vi.fn().mockResolvedValue([]),
  fetchMapset: vi.fn().mockResolvedValue(null),
}));

const mockDeletePersistedPassphrase = vi.fn();

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    getKey: vi.fn().mockResolvedValue({} as CryptoKey),
    isUnlocked: vi.fn(() => true),
    isPersisted: vi.fn(() => false),
    deletePersistedPassphrase: mockDeletePersistedPassphrase,
  }),
}));

vi.mock('../utils/crypto', () => ({
  encrypt: vi.fn().mockResolvedValue('encrypted-mock'),
  mapsetFieldAad: vi.fn().mockReturnValue('Mapset|id|id'),
}));

function renderModal(overrides: Partial<React.ComponentProps<typeof EditMapsetModal>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const props: React.ComponentProps<typeof EditMapsetModal> = {
    mapsetId: 'test-mapset-id',
    currentTitle: 'Original Title',
    currentDescription: 'Original description',
    currentSongLengthMs: 90_000,
    currentAllowKeepOnBrowser: false,
    onSuccess: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <EditMapsetModal {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return props;
}

describe('EditMapsetModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefills the current title, description, and song length', () => {
    renderModal();
    expect(screen.getByLabelText(/title/i)).toHaveValue('Original Title');
    expect(screen.getByLabelText(/description/i)).toHaveValue('Original description');
    // 90_000 ms → 1 minute 30 seconds.
    expect(screen.getByLabelText(/minutes/i)).toHaveValue(1);
    expect(screen.getByLabelText(/seconds/i)).toHaveValue(30);
  });

  it('submits the edited fields and calls onSuccess', async () => {
    const user = userEvent.setup();
    const { onSuccess } = renderModal();

    const titleInput = screen.getByLabelText(/title/i);
    await user.clear(titleInput);
    await user.type(titleInput, 'Updated Title');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(vi.mocked(updateMapset)).toHaveBeenCalledTimes(1));
    const [id, payload] = vi.mocked(updateMapset).mock.calls[0];
    expect(id).toBe('test-mapset-id');
    expect(payload.title).toBe('Updated Title');
    expect(payload.encrypted_description).toBe('encrypted-mock');
    expect(payload.encrypted_song_length_ms).toBe('encrypted-mock');
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('clears the description when emptied (sends null)', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.clear(screen.getByLabelText(/description/i));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(vi.mocked(updateMapset)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateMapset).mock.calls[0][1].encrypted_description).toBeNull();
  });

  it('omits song length when both inputs are blank (leaves it unchanged)', async () => {
    const user = userEvent.setup();
    renderModal({ currentSongLengthMs: null });

    // Minutes/seconds start empty; just change the title and save.
    const titleInput = screen.getByLabelText(/title/i);
    await user.clear(titleInput);
    await user.type(titleInput, 'Renamed');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(vi.mocked(updateMapset)).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(updateMapset).mock.calls[0][1];
    expect(payload).not.toHaveProperty('encrypted_song_length_ms');
  });

  it('does not submit with an empty title', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.clear(screen.getByLabelText(/title/i));
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(vi.mocked(updateMapset)).not.toHaveBeenCalled();
  });

  it('submits allow_keep_on_browser when the toggle is checked', async () => {
    const user = userEvent.setup();
    renderModal({ currentAllowKeepOnBrowser: false });

    await user.click(screen.getByRole('checkbox', { name: /allow members to keep the passphrase/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(vi.mocked(updateMapset)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateMapset).mock.calls[0][1].allow_keep_on_browser).toBe(true);
  });

  it('submits allow_keep_on_browser false when the toggle is unchecked', async () => {
    const user = userEvent.setup();
    renderModal({ currentAllowKeepOnBrowser: true });

    await user.click(screen.getByRole('checkbox', { name: /allow members to keep the passphrase/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(vi.mocked(updateMapset)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateMapset).mock.calls[0][1].allow_keep_on_browser).toBe(false);
  });

  it('purges a persisted passphrase immediately when the owner revokes browser persistence', async () => {
    const user = userEvent.setup();
    renderModal({ currentAllowKeepOnBrowser: true });

    await user.click(screen.getByRole('checkbox', { name: /allow members to keep the passphrase/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(vi.mocked(updateMapset)).toHaveBeenCalledTimes(1));
    expect(mockDeletePersistedPassphrase).toHaveBeenCalledWith('test-mapset-id');
  });
});
