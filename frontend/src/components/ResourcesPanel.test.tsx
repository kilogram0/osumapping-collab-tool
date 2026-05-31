import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ResourcesPanel from './ResourcesPanel';
import type { MapsetResource } from '../api/endpoints';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDecrypt = vi.fn(async (_key: unknown, _ct: string, _aad: string) => 'decrypted');
const mockEncrypt = vi.fn(async (_key: unknown, plain: string, _aad: string) => `enc:${plain}`);
const mockMapsetResourceAad = vi.fn((rid: string, mid: string) => `MapsetResource|${rid}|${mid}`);

vi.mock('../utils/crypto', () => ({
  decrypt: (...args: Parameters<typeof mockDecrypt>) => mockDecrypt(...args),
  encrypt: (...args: Parameters<typeof mockEncrypt>) => mockEncrypt(...args),
  mapsetResourceAad: (...args: Parameters<typeof mockMapsetResourceAad>) => mockMapsetResourceAad(...args),
}));

Object.defineProperty(globalThis, 'crypto', {
  value: { ...globalThis.crypto, randomUUID: () => 'new-resource-id' },
  writable: true,
});

vi.mock('../utils/errors', () => ({
  extractApiErrorMessage: (err: unknown) => (err instanceof Error ? err.message : null),
}));

const mockGetKey = vi.fn(async (_id: string) => ({ type: 'secret' } as unknown as CryptoKey));
const mockIsUnlocked = vi.fn((_id: string) => true);

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    isUnlocked: mockIsUnlocked,
    getKey: mockGetKey,
  }),
}));

const mockCreateMutateAsync = vi.fn(async () => ({}));
const mockDeleteMutateAsync = vi.fn(async () => undefined);
let resourcesData: MapsetResource[] = [];

vi.mock('../hooks/useMapset', () => ({
  useResources: () => ({ data: resourcesData }),
  useCreateResource: () => ({ mutateAsync: mockCreateMutateAsync, isPending: false }),
  useDeleteResource: () => ({ mutateAsync: mockDeleteMutateAsync, isPending: false }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESOURCE: MapsetResource = {
  id: 'res-1',
  mapset_id: 'ms-1',
  encrypted_name: 'enc-name',
  encrypted_url: 'enc-url',
  encrypted_icon: null,
  position: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function renderPanel(props?: Partial<React.ComponentProps<typeof ResourcesPanel>>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ResourcesPanel mapsetId="ms-1" isOwner={false} {...props} />
    </QueryClientProvider>,
  );
}

const heading = () => screen.queryByRole('heading', { name: /resources/i });
const editButton = () => screen.getByRole('button', { name: /^edit$/i });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResourcesPanel — visibility rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
  });

  it('hides the card entirely for non-owners when no resources exist', () => {
    resourcesData = [];
    renderPanel({ isOwner: false });
    expect(heading()).toBeNull();
  });

  it('shows the card for owners even when no resources exist', () => {
    resourcesData = [];
    renderPanel({ isOwner: true });
    expect(heading()).toBeInTheDocument();
    expect(screen.getByText(/no resources yet/i)).toBeInTheDocument();
  });

  it('shows the card for non-owners when resources exist', () => {
    resourcesData = [RESOURCE];
    renderPanel({ isOwner: false });
    expect(heading()).toBeInTheDocument();
  });

  it('shows the resource count in the header', () => {
    resourcesData = [RESOURCE];
    renderPanel({ isOwner: true });
    expect(screen.getByText('(1)')).toBeInTheDocument();
  });
});

describe('ResourcesPanel — static list (always visible, unlocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
    mockDecrypt.mockResolvedValue('decrypted');
    resourcesData = [RESOURCE];
  });

  it('renders the decrypted resource as a link without any expand step', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByRole('link', { name: 'decrypted' })).toBeInTheDocument());
  });

  it('link has the decrypted URL and opens in a new tab', async () => {
    mockDecrypt
      .mockResolvedValueOnce('My Resource')
      .mockResolvedValueOnce('https://example.com/file.osz');
    renderPanel();
    await waitFor(() => {
      const link = screen.getByRole('link', { name: 'My Resource' });
      expect(link).toHaveAttribute('href', 'https://example.com/file.osz');
      expect(link).toHaveAttribute('target', '_blank');
    });
  });

  it('decrypts the icon with the same resource AAD when present', async () => {
    resourcesData = [{ ...RESOURCE, encrypted_icon: 'enc-icon' }];
    mockDecrypt.mockResolvedValue('music');
    renderPanel();
    await waitFor(() => expect(screen.getByRole('link')).toBeInTheDocument());
    // name, url, and icon all decrypted with the row's AAD.
    expect(mockDecrypt).toHaveBeenCalledWith(expect.anything(), 'enc-icon', 'MapsetResource|res-1|ms-1');
  });

  it('still renders the row when the icon fails to decrypt', async () => {
    resourcesData = [{ ...RESOURCE, encrypted_icon: 'enc-icon' }];
    mockDecrypt.mockImplementation(async (_k, ct: string) => {
      if (ct === 'enc-icon') throw new Error('bad icon');
      return 'ok';
    });
    renderPanel();
    await waitFor(() => expect(screen.getByRole('link', { name: 'ok' })).toBeInTheDocument());
  });

  it('non-owner sees no Edit or Remove controls', async () => {
    renderPanel({ isOwner: false });
    await waitFor(() => expect(screen.getByRole('link')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  });
});

describe('ResourcesPanel — locked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(false);
    resourcesData = [RESOURCE];
  });

  it('shows the unlock message and no links when locked', () => {
    renderPanel();
    expect(screen.getByText(/unlock this mapset/i)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('ResourcesPanel — owner edit mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
    mockDecrypt.mockResolvedValue('decrypted');
    resourcesData = [RESOURCE];
  });

  it('Add/Remove controls are hidden until Edit is clicked', async () => {
    renderPanel({ isOwner: true });
    await waitFor(() => expect(screen.getByRole('link')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /add resource/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove resource/i })).toBeNull();

    await userEvent.click(editButton());
    expect(screen.getByRole('button', { name: /add resource/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove resource/i })).toBeInTheDocument();
  });

  it('Remove calls the delete mutation with the resource id', async () => {
    renderPanel({ isOwner: true });
    await userEvent.click(editButton());
    await userEvent.click(screen.getByRole('button', { name: /remove resource/i }));
    expect(mockDeleteMutateAsync).toHaveBeenCalledWith(RESOURCE.id);
  });

  it('opens the add form with name, url, and an icon picker', async () => {
    renderPanel({ isOwner: true });
    await userEvent.click(editButton());
    await userEvent.click(screen.getByRole('button', { name: /add resource/i }));
    expect(screen.getByPlaceholderText(/name/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/url/i)).toBeInTheDocument();
    // icon picker buttons (one per pool key)
    expect(screen.getByRole('button', { name: 'Audio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Image' })).toBeInTheDocument();
  });

  it('submitting creates a resource with the default (link) icon', async () => {
    renderPanel({ isOwner: true });
    await userEvent.click(editButton());
    await userEvent.click(screen.getByRole('button', { name: /add resource/i }));
    await userEvent.type(screen.getByPlaceholderText(/name/i), '.osz download');
    await userEvent.type(screen.getByPlaceholderText(/url/i), 'https://example.com/map.osz');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() =>
      expect(mockCreateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'new-resource-id',
          encrypted_name: 'enc:.osz download',
          encrypted_url: 'enc:https://example.com/map.osz',
          encrypted_icon: 'enc:link',
        }),
      ),
    );
  });

  it('encrypts the chosen icon when a different one is picked', async () => {
    renderPanel({ isOwner: true });
    await userEvent.click(editButton());
    await userEvent.click(screen.getByRole('button', { name: /add resource/i }));
    await userEvent.type(screen.getByPlaceholderText(/name/i), 'hitsounds');
    await userEvent.type(screen.getByPlaceholderText(/url/i), 'https://example.com/hs.zip');
    await userEvent.click(screen.getByRole('button', { name: 'Audio' }));
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() =>
      expect(mockCreateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ encrypted_icon: 'enc:music' }),
      ),
    );
    expect(mockEncrypt).toHaveBeenCalledWith(expect.anything(), 'music', expect.any(String));
  });

  it('shows a validation error for an empty name', async () => {
    renderPanel({ isOwner: true });
    await userEvent.click(editButton());
    await userEvent.click(screen.getByRole('button', { name: /add resource/i }));
    await userEvent.type(screen.getByPlaceholderText(/url/i), 'https://example.com');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(screen.getByText(/name is required/i)).toBeInTheDocument();
    expect(mockCreateMutateAsync).not.toHaveBeenCalled();
  });

  it('shows a validation error for an invalid URL', async () => {
    renderPanel({ isOwner: true });
    await userEvent.click(editButton());
    await userEvent.click(screen.getByRole('button', { name: /add resource/i }));
    await userEvent.type(screen.getByPlaceholderText(/name/i), 'OSZ');
    await userEvent.type(screen.getByPlaceholderText(/url/i), 'not-a-url');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(screen.getByText(/must start with http/i)).toBeInTheDocument();
    expect(mockCreateMutateAsync).not.toHaveBeenCalled();
  });

  it('shows an error message when delete fails', async () => {
    mockDeleteMutateAsync.mockRejectedValueOnce(new Error('Server error'));
    renderPanel({ isOwner: true });
    await userEvent.click(editButton());
    await userEvent.click(screen.getByRole('button', { name: /remove resource/i }));
    await waitFor(() => expect(screen.getByText(/server error/i)).toBeInTheDocument());
  });
});
