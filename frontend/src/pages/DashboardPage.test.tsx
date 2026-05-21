import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import DashboardPage from './DashboardPage';
import type { Mapset } from '../api/endpoints';
import { ToastProvider } from '../contexts/ToastContext';

vi.mock('../api/endpoints', () => ({
  fetchMapsets: vi.fn(),
  fetchCurrentUser: vi.fn().mockResolvedValue(null),
  logout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock('../hooks/useMapset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useMapset')>();
  return {
    ...actual,
    useScheduleMapsetDeletion: () => ({ mutate: vi.fn() }),
    useCancelMapsetDeletion: () => ({ mutate: vi.fn() }),
  };
});

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    isUnlocked: vi.fn(() => false),
    getKey: vi.fn().mockResolvedValue(null),
    unlockMapset: vi.fn().mockResolvedValue(undefined),
    unlockWithKey: vi.fn().mockResolvedValue(undefined),
    lockMapset: vi.fn().mockResolvedValue(undefined),
    clearAll: vi.fn().mockResolvedValue(undefined),
  }),
  EncryptionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const MAPSET: Mapset = {
  id: 'mapset-1',
  title: 'Test Mapset',
  encrypted_description: null,
  encrypted_song_length_ms: 'encrypted:0',
  passphrase_salt: 'c2FsdA==',
  encrypted_verification: 'encrypted:verified',
  owner_id: 'owner-uuid',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  delete_at: null,
};

function renderDashboard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('DashboardPage', () => {
  it('renders the dashboard heading', async () => {
    const { fetchMapsets } = await import('../api/endpoints');
    vi.mocked(fetchMapsets).mockResolvedValue([]);
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument());
  });

  it('renders the Create Mapset button', async () => {
    const { fetchMapsets } = await import('../api/endpoints');
    vi.mocked(fetchMapsets).mockResolvedValue([]);
    renderDashboard();
    await waitFor(() => expect(screen.getByRole('button', { name: /create mapset/i })).toBeInTheDocument());
  });

  it('shows empty state when user has no mapsets', async () => {
    const { fetchMapsets } = await import('../api/endpoints');
    vi.mocked(fetchMapsets).mockResolvedValue([]);
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/no mapsets yet/i)).toBeInTheDocument());
  });

  it('renders a MapsetCard for each mapset', async () => {
    const { fetchMapsets } = await import('../api/endpoints');
    vi.mocked(fetchMapsets).mockResolvedValue([MAPSET]);
    renderDashboard();
    await waitFor(() => expect(screen.getAllByTestId('mapset-card')).toHaveLength(1));
  });

  it('opens create mapset modal when Create Mapset is clicked', async () => {
    const { fetchMapsets } = await import('../api/endpoints');
    vi.mocked(fetchMapsets).mockResolvedValue([]);
    renderDashboard();
    await waitFor(() => screen.getByRole('button', { name: /create mapset/i }));
    await userEvent.click(screen.getByRole('button', { name: /create mapset/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /create mapset/i })).toBeInTheDocument();
  });
});
