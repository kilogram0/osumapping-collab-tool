import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import MapsetPage from './MapsetPage';

const mockIsUnlocked = vi.fn(() => true);
const mockGetKey = vi.fn(async () => ({ key: 'mock-key' } as unknown as CryptoKey));
const mockUnlockMapset = vi.fn();
const mockUnlockWithKey = vi.fn();

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    isUnlocked: mockIsUnlocked,
    getKey: mockGetKey,
    unlockMapset: mockUnlockMapset,
    unlockWithKey: mockUnlockWithKey,
    lockMapset: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: {
      id: 'current-user-uuid',
      osu_id: 12345,
      username: 'testuser',
      avatar_url: 'https://a.ppy.sh/12345',
      created_at: '',
      updated_at: '',
    },
    isLoading: false,
    isAuthenticated: true,
    login: vi.fn(),
    logout: vi.fn(),
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
    decodeJsonEnvelope: vi.fn((plaintext: string) => {
      try {
        const parsed = JSON.parse(plaintext);
        if (typeof parsed.ms === 'number') return parsed.ms;
        if (typeof parsed.v === 'number') return parsed.v;
      } catch {
        return Number(plaintext);
      }
      return Number(plaintext);
    }),
    mapsetFieldAad: vi.fn((mapsetId: string) => `Mapset|${mapsetId}|${mapsetId}`),
    difficultyFieldAad: vi.fn((id: string, mapsetId: string) => `Difficulty|${id}|${mapsetId}`),
    sectionFieldAad: vi.fn((id: string, mapsetId: string) => `Section|${id}|${mapsetId}`),
  };
});

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

const MOCK_MAPSET = {
  id: 'ms1',
  title: 'Test Mapset',
  encrypted_description: 'enc:A test description',
  encrypted_song_length_ms: 'enc:{"v":1,"ms":245000}',
  passphrase_salt: 'salt',
  encrypted_verification: 'enc:verified',
  owner_id: 'owner-uuid',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const MOCK_DIFFICULTIES = [
  {
    id: 'd1',
    mapset_id: 'ms1',
    encrypted_name: 'enc:Hard',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
];

const MOCK_SECTIONS = [
  {
    id: 's1',
    difficulty_id: 'd1',
    encrypted_name: 'enc:Intro',
    encrypted_start_time_ms: 'enc:{"v":0,"ms":0}',
    encrypted_end_time_ms: 'enc:{"v":0,"ms":30000}',
    encrypted_sort_order: 'enc:{"v":0,"ms":0}',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
];

const mockUseMyMembership = vi.fn(() => ({
  data: {
    id: 'member-1',
    mapset_id: 'ms1',
    user_id: 'current-user-uuid',
    role: 'owner',
    created_at: '',
    updated_at: '',
  },
  isLoading: false,
}));

vi.mock('../hooks/useMapset', () => ({
  useMapset: () => ({
    data: MOCK_MAPSET,
    isLoading: false,
    isError: false,
  }),
  useMapsets: () => ({
    data: [MOCK_MAPSET],
    isLoading: false,
    isError: false,
  }),
  useMyMembership: (mapsetId: string) => mockUseMyMembership(mapsetId),
}));

vi.mock('../hooks/useDifficulty', () => ({
  useDifficulties: () => ({
    data: MOCK_DIFFICULTIES,
    isLoading: false,
  }),
  useSections: () => ({
    data: MOCK_SECTIONS,
    isLoading: false,
  }),
  useCreateDifficulty: () => ({
    mutateAsync: vi.fn(),
  }),
  useCreateSection: () => ({
    mutateAsync: vi.fn(),
  }),
  useUpdateSection: () => ({
    mutateAsync: vi.fn(),
  }),
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/mapsets/ms1']}>
        <Routes>
          <Route path="/mapsets/:id" element={<MapsetPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MapsetPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({ key: 'mock-key' } as unknown as CryptoKey);
  });

  it('renders mapset title and decrypted metadata', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Test Mapset')).toBeInTheDocument();
    });
    expect(screen.getByText('A test description')).toBeInTheDocument();
    expect(screen.getByText('04:05')).toBeInTheDocument();
  });

  it('shows Add Difficulty and Add Section buttons for owner', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add Difficulty/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Add Section/i })).toBeInTheDocument();
  });

  it('opens create difficulty modal when Add Difficulty is clicked', async () => {
    renderPage();
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add Difficulty/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Add Difficulty/i }));
    expect(screen.getByRole('heading', { name: /Add Difficulty/i })).toBeInTheDocument();
  });

  it('opens create section modal when Add Section is clicked', async () => {
    renderPage();
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add Section/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Add Section/i }));
    expect(screen.getByRole('heading', { name: /Add Section/i })).toBeInTheDocument();
  });

  it('opens edit section modal when Edit is clicked', async () => {
    renderPage();
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Edit/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Edit/i }));
    expect(screen.getByRole('heading', { name: /Edit Section/i })).toBeInTheDocument();
  });

  it('shows Add buttons for mapper role', async () => {
    mockUseMyMembership.mockReturnValue({
      data: {
        id: 'member-2',
        mapset_id: 'ms1',
        user_id: 'current-user-uuid',
        role: 'mapper',
        created_at: '',
        updated_at: '',
      },
      isLoading: false,
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add Difficulty/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Add Section/i })).toBeInTheDocument();
  });

  it('hides Add buttons for modder role', async () => {
    mockUseMyMembership.mockReturnValue({
      data: {
        id: 'member-3',
        mapset_id: 'ms1',
        user_id: 'current-user-uuid',
        role: 'modder',
        created_at: '',
        updated_at: '',
      },
      isLoading: false,
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Test Mapset')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Add Difficulty/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add Section/i })).not.toBeInTheDocument();
  });
});
