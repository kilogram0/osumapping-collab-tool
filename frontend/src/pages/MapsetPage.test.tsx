import { render, screen, waitFor, act, within } from '@testing-library/react';
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
    encrypt: vi.fn(async (_key: CryptoKey, plaintext: string, _aad: string) => `enc:${plaintext}`),
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
    postFieldAad: vi.fn((postId: string, mapsetId: string) => `Post|${postId}|${mapsetId}`),
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

const MOCK_POSTS = [
  {
    id: 'p1',
    difficulty_id: 'd1',
    author_id: 'current-user-uuid',
    parent_id: null,
    tag: 'suggestion',
    encrypted_body: 'enc:00:46:140 (2,3,4) - these are too close',
    created_at: '2024-01-01T12:00:00Z',
    updated_at: '2024-01-01T12:00:00Z',
  },
  {
    id: 'p2',
    difficulty_id: 'd1',
    author_id: 'other-user-uuid',
    parent_id: null,
    tag: 'general',
    encrypted_body: 'enc:Nice map overall',
    created_at: '2024-01-01T13:00:00Z',
    updated_at: '2024-01-01T13:00:00Z',
  },
];

const MOCK_DIFFICULTY_DETAIL = {
  id: 'd1',
  mapset_id: 'ms1',
  encrypted_name: 'enc:Hard',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  sections: MOCK_SECTIONS,
  posts: MOCK_POSTS,
};

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

const mockCreatePost = vi.fn().mockResolvedValue({});
const mockUpdatePost = vi.fn().mockResolvedValue({});
const mockDeletePost = vi.fn().mockResolvedValue({});

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
  useDifficultyDetail: () => ({
    data: MOCK_DIFFICULTY_DETAIL,
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
  useCreatePost: () => ({
    mutateAsync: mockCreatePost,
  }),
  useUpdatePost: () => ({
    mutateAsync: mockUpdatePost,
  }),
  useDeletePost: () => ({
    mutateAsync: mockDeletePost,
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
    mockCreatePost.mockClear();
    mockUpdatePost.mockClear();
    mockDeletePost.mockClear();
    mockUseMyMembership.mockReturnValue({
      data: {
        id: 'member-1',
        mapset_id: 'ms1',
        user_id: 'current-user-uuid',
        role: 'owner',
        created_at: '',
        updated_at: '',
      },
      isLoading: false,
    });
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
      expect(screen.getAllByRole('button', { name: /Edit/i }).length).toBeGreaterThanOrEqual(1);
    });
    const editButtons = screen.getAllByRole('button', { name: /Edit/i });
    await user.click(editButtons[0]);
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

  it('renders decrypted posts in the forum thread', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Forum')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Nice map overall/i)).toBeInTheDocument();
  });

  it('sorts posts by extracted timestamp then created_at', async () => {
    const originalPosts = MOCK_DIFFICULTY_DETAIL.posts;
    MOCK_DIFFICULTY_DETAIL.posts = [
      {
        id: 'p-later',
        difficulty_id: 'd1',
        author_id: 'other-user-uuid',
        parent_id: null,
        tag: 'general',
        encrypted_body: 'enc:01:30:000 - later timestamp',
        created_at: '2024-01-01T14:00:00Z',
        updated_at: '2024-01-01T14:00:00Z',
      },
      {
        id: 'p-earlier',
        difficulty_id: 'd1',
        author_id: 'other-user-uuid',
        parent_id: null,
        tag: 'general',
        encrypted_body: 'enc:00:15:000 - earlier timestamp',
        created_at: '2024-01-01T15:00:00Z',
        updated_at: '2024-01-01T15:00:00Z',
      },
      {
        id: 'p-none',
        difficulty_id: 'd1',
        author_id: 'other-user-uuid',
        parent_id: null,
        tag: 'general',
        encrypted_body: 'enc:no timestamp here',
        created_at: '2024-01-01T13:00:00Z',
        updated_at: '2024-01-01T13:00:00Z',
      },
    ];
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/earlier timestamp/i)).toBeInTheDocument();
    });

    const postCards = screen.getAllByTestId('post-card');
    expect(postCards[0].textContent).toMatch(/earlier timestamp/);
    expect(postCards[1].textContent).toMatch(/later timestamp/);
    expect(postCards[2].textContent).toMatch(/no timestamp here/);

    MOCK_DIFFICULTY_DETAIL.posts = originalPosts;
  });

  it('shows New Post button and opens create form', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New Post/i })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /New Post/i }));
    expect(screen.getByLabelText(/New post/i)).toBeInTheDocument();
  });

  it('creates a new post through the form', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New Post/i })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /New Post/i }));

    const textarea = screen.getByLabelText(/New post/i);
    await user.type(textarea, '01:00:000 - great rhythm');

    // Use exact text match to avoid matching collapse buttons with aria-label "Collapse post"
    await user.click(screen.getByRole('button', { name: /^Post$/i }));

    await waitFor(() => {
      expect(mockCreatePost).toHaveBeenCalledTimes(1);
    });

    const payload = mockCreatePost.mock.calls[0][0];
    expect(payload.tag).toBe('general');
    expect(payload.encrypted_body).toBe('enc:01:00:000 - great rhythm');
  });

  it('shows edit and delete buttons on own posts', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
    });
    const postCards = screen.getAllByTestId('post-card');
    const ownPost = postCards.find((card) => within(card).queryByText(/these are too close/i));
    expect(ownPost).toBeDefined();
    const withinOwnPost = within(ownPost!);
    expect(withinOwnPost.getByRole('button', { name: /Edit/i })).toBeInTheDocument();
    expect(withinOwnPost.getByRole('button', { name: /Delete/i })).toBeInTheDocument();
  });

  it('deletes a post when Delete is clicked', async () => {
    window.confirm = vi.fn(() => true);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
    });
    const user = userEvent.setup();
    const deleteButtons = screen.getAllByRole('button', { name: /Delete/i });
    await user.click(deleteButtons[0]);

    await waitFor(() => {
      expect(mockDeletePost).toHaveBeenCalledTimes(1);
    });
  });

  it('opens reply form when Reply is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Nice map overall/i)).toBeInTheDocument();
    });
    const user = userEvent.setup();
    const replyButtons = screen.getAllByRole('button', { name: /Reply/i });
    await user.click(replyButtons[0]);

    await waitFor(() => {
      expect(screen.getByLabelText(/Reply/i)).toBeInTheDocument();
    });
  });

  it('opens edit form when Edit is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
    });
    const user = userEvent.setup();
    const postCards = screen.getAllByTestId('post-card');
    const ownPost = postCards.find((card) => within(card).queryByText(/these are too close/i));
    expect(ownPost).toBeDefined();
    const editButton = within(ownPost!).getByRole('button', { name: /Edit/i });
    await user.click(editButton);

    await waitFor(() => {
      expect(screen.getByLabelText(/Edit post/i)).toBeInTheDocument();
    });
  });
});
