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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResourcesPanel — visibility rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
  });

  it('hides the panel entirely for non-owners when no resources are uploaded', () => {
    resourcesData = [];
    renderPanel({ isOwner: false });
    expect(screen.queryByRole('button', { name: /resources/i })).toBeNull();
  });

  it('shows the panel for owners even when no resources are uploaded', () => {
    resourcesData = [];
    renderPanel({ isOwner: true });
    expect(screen.getByRole('button', { name: /resources/i })).toBeInTheDocument();
  });

  it('shows the panel for non-owners when resources exist', () => {
    resourcesData = [RESOURCE];
    renderPanel({ isOwner: false });
    expect(screen.getByRole('button', { name: /resources/i })).toBeInTheDocument();
  });
});

describe('ResourcesPanel (collapsed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
    resourcesData = [];
  });

  it('renders the Resources toggle button (owner)', () => {
    renderPanel({ isOwner: true });
    expect(screen.getByRole('button', { name: /resources/i })).toBeInTheDocument();
  });

  it('is collapsed by default — content is not visible', () => {
    resourcesData = [RESOURCE];
    renderPanel();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows resource count in toggle when resources exist', () => {
    resourcesData = [RESOURCE];
    renderPanel();
    expect(screen.getByText('(1)')).toBeInTheDocument();
  });
});

describe('ResourcesPanel (expanded, unlocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
    mockDecrypt.mockResolvedValue('decrypted');
    resourcesData = [RESOURCE];
  });

  it('expands on click and shows decrypted resource as link', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /resources/i }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'decrypted' })).toBeInTheDocument());
  });

  it('link has the decrypted URL and opens in a new tab', async () => {
    mockDecrypt
      .mockResolvedValueOnce('My Resource')
      .mockResolvedValueOnce('https://example.com/file.osz');
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /resources/i }));
    await waitFor(() => {
      const link = screen.getByRole('link', { name: 'My Resource' });
      expect(link).toHaveAttribute('href', 'https://example.com/file.osz');
      expect(link).toHaveAttribute('target', '_blank');
    });
  });

  it('non-owner does not see Remove button', async () => {
    renderPanel({ isOwner: false });
    await userEvent.click(screen.getByRole('button', { name: /resources/i }));
    await waitFor(() => expect(screen.getByRole('link')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  });
});

describe('ResourcesPanel (expanded, locked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(false);
    resourcesData = [RESOURCE];
  });

  it('shows unlock message when locked', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /resources/i }));
    expect(screen.getByText(/unlock this mapset/i)).toBeInTheDocument();
  });
});

describe('ResourcesPanel — owner controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
    mockDecrypt.mockResolvedValue('decrypted');
    resourcesData = [RESOURCE];
  });

  it('owner sees Add resource button', async () => {
    renderPanel({ isOwner: true });
    await userEvent.click(screen.getByRole('button', { name: /resources/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /add resource/i })).toBeInTheDocument());
  });

  it('owner sees Remove button per resource', async () => {
    renderPanel({ isOwner: true });
    await userEvent.click(screen.getByRole('button', { name: /resources/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /remove resource/i })).toBeInTheDocument());
  });

  it('clicking Remove calls delete mutation with resource id', async () => {
    renderPanel({ isOwner: true });
    await userEvent.click(screen.getByRole('button', { name: /resources/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /remove resource/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /remove resource/i }));
    expect(mockDeleteMutateAsync).toHaveBeenCalledWith(RESOURCE.id);
  });

  it('shows add form when Add resource is clicked', async () => {
    renderPanel({ isOwner: true });
    await userEvent.click(screen.getByRole('button', { name: /resources/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /add resource/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /add resource/i }));
    expect(screen.getByPlaceholderText(/name/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/url/i)).toBeInTheDocument();
  });

  it('submitting the add form calls createMutation with encrypted fields', async () => {
    renderPanel({ isOwner: true });
    await userEvent.click(screen.getByRole('button', { name: /resources/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /add resource/i })).toBeInTheDocument());
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
        }),
      ),
    );
  });

  it('shows validation error for empty name', async () => {
    renderPanel({ isOwner: true });
    await userEvent.click(screen.getByRole('button', { name: /resources/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /add resource/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /add resource/i }));
    await userEvent.type(screen.getByPlaceholderText(/url/i), 'https://example.com');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(screen.getByText(/name is required/i)).toBeInTheDocument();
    expect(mockCreateMutateAsync).not.toHaveBeenCalled();
  });

  it('shows validation error for invalid URL', async () => {
    renderPanel({ isOwner: true });
    await userEvent.click(screen.getByRole('button', { name: /resources/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /add resource/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /add resource/i }));
    await userEvent.type(screen.getByPlaceholderText(/name/i), 'OSZ');
    await userEvent.type(screen.getByPlaceholderText(/url/i), 'not-a-url');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(screen.getByText(/must start with http/i)).toBeInTheDocument();
    expect(mockCreateMutateAsync).not.toHaveBeenCalled();
  });

  it('shows error message when delete fails', async () => {
    mockDeleteMutateAsync.mockRejectedValueOnce(new Error('Server error'));
    renderPanel({ isOwner: true });
    await userEvent.click(screen.getByRole('button', { name: /resources/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /remove resource/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /remove resource/i }));
    await waitFor(() => expect(screen.getByText(/server error/i)).toBeInTheDocument());
  });
});
