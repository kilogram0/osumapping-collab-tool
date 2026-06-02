import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PinButton from './PinButton';
import { ToastProvider } from '../contexts/ToastContext';
import type { Section } from '../api/endpoints';

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

const mockCreatePin = vi.fn(async () => ({ id: 'p-new' }));
const mockFetchPins = vi.fn();
const mockFetchPin = vi.fn();
const mockDeletePin = vi.fn(async () => undefined);

vi.mock('../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/endpoints')>();
  return {
    ...actual,
    createPin: (...args: unknown[]) => mockCreatePin(...args),
    fetchPins: (...args: unknown[]) => mockFetchPins(...args),
    fetchPin: (...args: unknown[]) => mockFetchPin(...args),
    deletePin: (...args: unknown[]) => mockDeletePin(...args),
  };
});

// encrypt/decrypt are simple reversible string transforms so the test can prove
// the payload that reaches the API is ciphertext, not plaintext.
vi.mock('../utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/crypto')>();
  return {
    ...actual,
    encrypt: vi.fn(async (_key: CryptoKey, plaintext: string, _aad: string) => `enc:${plaintext}`),
    decrypt: vi.fn(async (_key: CryptoKey, ciphertext: string, _aad: string) =>
      ciphertext.replace(/^enc:/, ''),
    ),
    decodeJsonEnvelope: vi.fn((v: string) => Number(v)),
  };
});

vi.mock('../utils/sectionDownload', () => ({
  assembleFullOsu: vi.fn(async () => ({ content: 'ASSEMBLED_OSU', basePlaintext: '', baseVersion: 1 })),
}));

vi.mock('../utils/osuParser', () => ({
  parseOsuFile: vi.fn((c: string) => ({ raw: c })),
  withMetadataVersion: vi.fn((_parsed: unknown, diffName: string) => ({
    content: `content-${diffName}`,
    metadata: { artist: 'Artist', title: 'Title' },
  })),
}));
vi.mock('../utils/osuFilename', () => ({
  composeOsuFilename: vi.fn(({ diffName }: { diffName: string }) => `${diffName}.osu`),
}));
vi.mock('../utils/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

function section(id: string): Section {
  return {
    id,
    difficulty_id: 'd1',
    encrypted_name: 'enc:name',
    encrypted_sort_order: 'enc:0',
    encrypted_end_time_ms: 'enc:1000',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  } as unknown as Section;
}

function setup(overrides: Partial<React.ComponentProps<typeof PinButton>> = {}) {
  const props = {
    difficultyId: 'd1',
    mapsetId: 'ms1',
    mapsetTitle: 'My Mapset',
    sections: [section('s1')],
    difficultyName: 'Insane',
    isOwner: true,
    resolveUsername: (id: string) => (id === 'u1' ? 'alice' : undefined),
    ...overrides,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <PinButton {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return props;
}

describe('PinButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
    mockFetchPins.mockResolvedValue([]);
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('shows both menu options for an owner', async () => {
    const user = userEvent.setup();
    setup({ isOwner: true });
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    expect(screen.getByRole('menuitem', { name: 'Pin version' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'View pins' })).toBeInTheDocument();
  });

  it('hides "Pin version" for non-owners but still allows viewing pins', async () => {
    const user = userEvent.setup();
    setup({ isOwner: false });
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    expect(screen.queryByRole('menuitem', { name: 'Pin version' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'View pins' })).toBeInTheDocument();
  });

  it('disables "Pin version" when there are no sections', async () => {
    const user = userEvent.setup();
    setup({ sections: [] });
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    expect(screen.getByRole('menuitem', { name: 'Pin version' })).toBeDisabled();
  });

  it('defaults the pin name to v.DD.MM.YY', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    await user.click(screen.getByRole('menuitem', { name: 'Pin version' }));
    const input = screen.getByLabelText('Pin name') as HTMLInputElement;
    expect(input.value).toMatch(/^v\.\d{2}\.\d{2}\.\d{2}$/);
  });

  it('assembles, encrypts, and POSTs ciphertext when pinning', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    await user.click(screen.getByRole('menuitem', { name: 'Pin version' }));

    const dialog = screen.getByRole('dialog');
    const nameInput = within(dialog).getByLabelText('Pin name');
    await user.clear(nameInput);
    await user.type(nameInput, 'version 1');
    await user.click(within(dialog).getByRole('button', { name: 'Pin' }));

    await waitFor(() => expect(mockCreatePin).toHaveBeenCalledTimes(1));
    const [difficultyId, payload] = mockCreatePin.mock.calls[0] as [string, Record<string, string>];
    expect(difficultyId).toBe('d1');
    // The assembled .osu must be encrypted before it leaves the client: the
    // payload is the ciphertext form, never the raw assembled string.
    expect(payload.encrypted_content).toBe('enc:ASSEMBLED_OSU');
    expect(payload.encrypted_content).not.toBe('ASSEMBLED_OSU');
    expect(payload.encrypted_label).toBe('enc:version 1');
    expect(payload.id).toBeTruthy();
    // And the content was run through encrypt() bound to the pin's own AAD.
    const { encrypt, difficultyPinAad } = await import('../utils/crypto');
    expect(encrypt).toHaveBeenCalledWith(expect.anything(), 'ASSEMBLED_OSU', difficultyPinAad(payload.id, 'ms1'));
  });

  it('aborts the pin (no POST) when a section fails to decrypt', async () => {
    const user = userEvent.setup();
    const { decrypt } = await import('../utils/crypto');
    // A pin is an archival snapshot, so a single undecryptable section must
    // abort rather than persist a quietly-incomplete .osu.
    (decrypt as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('bad section'));
    setup();
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    await user.click(screen.getByRole('menuitem', { name: 'Pin version' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Pin' }));

    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(mockCreatePin).not.toHaveBeenCalled();
  });

  it('lists pins with decrypted labels and downloads decrypted content', async () => {
    const user = userEvent.setup();
    mockFetchPins.mockResolvedValue([
      { id: 'p1', difficulty_id: 'd1', encrypted_label: 'enc:version 1', created_by: 'u1', created_at: '2026-01-02T00:00:00Z' },
    ]);
    mockFetchPin.mockResolvedValue({
      id: 'p1', difficulty_id: 'd1', encrypted_label: 'enc:version 1', created_by: 'u1',
      created_at: '2026-01-02T00:00:00Z', encrypted_content: 'enc:DOWNLOADED_OSU',
    });

    setup();
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    await user.click(screen.getByRole('menuitem', { name: 'View pins' }));

    // Label decrypts to plaintext in the list.
    expect(await screen.findByText('version 1')).toBeInTheDocument();
    expect(screen.getByText(/alice/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(mockFetchPin).toHaveBeenCalledWith('d1', 'p1'));
  });

  it('lets an owner delete a pin', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockFetchPins.mockResolvedValue([
      { id: 'p1', difficulty_id: 'd1', encrypted_label: 'enc:v1', created_by: 'u1', created_at: '2026-01-02T00:00:00Z' },
    ]);
    setup({ isOwner: true });
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    await user.click(screen.getByRole('menuitem', { name: 'View pins' }));
    await screen.findByText('v1');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockDeletePin).toHaveBeenCalledWith('d1', 'p1'));
  });

  it('disables the trigger while the mapset is locked', () => {
    mockIsUnlocked.mockReturnValue(false);
    setup();
    expect(screen.getByRole('button', { name: 'Pin' })).toBeDisabled();
  });
});
