import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import MapsetPage from './MapsetPage';
import { ToastProvider } from '../contexts/ToastContext';
import ToastContainer from '../components/ToastContainer';

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
    difficultyBaseOsuVersionAad: vi.fn((id: string, mapsetId: string) => `DifficultyBaseOsuVersion|${id}|${mapsetId}`),
  };
});

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../components/MergedDownloadButton', () => ({
  default: () => <button type="button">Download Full Difficulty (.osu)</button>,
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
    assignedTo: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 's2',
    difficulty_id: 'd1',
    encrypted_name: 'enc:Kiai 1',
    encrypted_start_time_ms: 'enc:{"v":0,"ms":30000}',
    encrypted_end_time_ms: 'enc:{"v":0,"ms":60000}',
    encrypted_sort_order: 'enc:{"v":0,"ms":1}',
    assignedTo: null,
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
  {
    id: 'p3',
    difficulty_id: 'd1',
    author_id: 'other-user-uuid',
    parent_id: 'p2',
    tag: 'general',
    encrypted_body: 'enc:Thanks for the feedback',
    created_at: '2024-01-01T14:00:00Z',
    updated_at: '2024-01-01T14:00:00Z',
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
const mockDeleteDifficulty = vi.fn().mockResolvedValue({});
const mockRestoreDifficulty = vi.fn().mockResolvedValue({});
const mockUseDifficulties = vi.fn(() => ({ data: MOCK_DIFFICULTIES, isLoading: false }));

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
  useMyMembership: (_mapsetId: string) => mockUseMyMembership(),
  useMembers: (_mapsetId: string, _enabled?: boolean) => ({
    data: [],
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('../hooks/useDifficulty', () => ({
  useDifficulties: (mapsetId: string, options?: { includePending?: boolean }) =>
    mockUseDifficulties(mapsetId, options),
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
  useDeleteSection: () => ({
    mutateAsync: vi.fn(),
  }),
  useAssignSection: () => ({
    mutateAsync: vi.fn(),
  }),
  useDeleteDifficulty: () => ({
    mutateAsync: mockDeleteDifficulty,
    isPending: false,
  }),
  useRestoreDifficulty: () => ({
    mutateAsync: mockRestoreDifficulty,
    isPending: false,
    variables: undefined,
  }),
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/mapsets/ms1']}>
          <Routes>
            <Route path="/mapsets/:id" element={<MapsetPage />} />
            <Route path="/dashboard" element={<div data-testid="dashboard-route">Dashboard</div>} />
          </Routes>
        </MemoryRouter>
        <ToastContainer />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('MapsetPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', vi.fn(() => ({ observe: vi.fn(), disconnect: vi.fn() })));
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({ key: 'mock-key' } as unknown as CryptoKey);
    mockCreatePost.mockClear();
    mockUpdatePost.mockClear();
    mockDeletePost.mockClear();
    mockDeleteDifficulty.mockClear();
    mockRestoreDifficulty.mockClear();
    mockUseDifficulties.mockReturnValue({ data: MOCK_DIFFICULTIES, isLoading: false });
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

  it('navigates back to dashboard when back button is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Test Mapset')).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Back to Dashboard/i }));
    await waitFor(() => {
      expect(screen.getByTestId('dashboard-route')).toBeInTheDocument();
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

  it('shows Add Difficulty button for owner', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add Difficulty/i })).toBeInTheDocument();
    });
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

  it('shows timeline with section blocks', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('timeline-bar')).toBeInTheDocument();
    });
    expect(screen.getByTestId('timeline-section-s1')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-section-s2')).toBeInTheDocument();
  });

  it('shows Add Section button for owner', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add Section/i })).toBeInTheDocument();
    });
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

  it('shows Section View and Show All Posts toggles', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Section View/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Show All Posts/i })).toBeInTheDocument();
  });

  it('shows section detail panel when a timeline section is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('timeline-section-s1')).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('timeline-section-s1'));
    await waitFor(() => {
      expect(screen.getByTestId('section-detail-panel')).toBeInTheDocument();
    });
    const panel = screen.getByTestId('section-detail-panel');
    expect(within(panel).getByRole('heading', { name: 'Intro' })).toBeInTheDocument();
  });

  it('shows all posts view when Show All Posts is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Show All Posts/i })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Show All Posts/i }));
    await waitFor(() => {
      expect(screen.getByText(/Nice map overall/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
  });

  it('creates a new post through the global all-posts form', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Show All Posts/i })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Show All Posts/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New Post/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /New Post/i }));

    const textarea = screen.getByLabelText(/New post/i);
    await user.type(textarea, '01:00:000 - great rhythm');

    await user.click(screen.getByRole('button', { name: /^Post$/i }));

    await waitFor(() => {
      expect(mockCreatePost).toHaveBeenCalledTimes(1);
    });

    const payload = mockCreatePost.mock.calls[0][0];
    expect(payload.tag).toBe('general');
    expect(payload.encrypted_body).toBe('enc:01:00:000 - great rhythm');
  });

  it('shows edit and delete buttons on own posts in all-posts view', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Show All Posts/i })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Show All Posts/i }));
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

  it('deletes a post when Delete is clicked in all-posts view', async () => {
    window.confirm = vi.fn(() => true);
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Show All Posts/i })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Show All Posts/i }));
    await waitFor(() => {
      expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
    });
    const postCards = screen.getAllByTestId('post-card');
    const ownPost = postCards.find((card) => within(card).queryByText(/these are too close/i));
    expect(ownPost).toBeDefined();
    await user.click(within(ownPost!).getByRole('button', { name: /Delete/i }));

    await waitFor(() => {
      expect(mockDeletePost).toHaveBeenCalledTimes(1);
    });
  });

  it('opens reply form when Reply is clicked in all-posts view', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Show All Posts/i })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Show All Posts/i }));
    await waitFor(() => {
      expect(screen.getByText(/Nice map overall/i)).toBeInTheDocument();
    });
    const replyButtons = screen.getAllByRole('button', { name: /Reply/i });
    await user.click(replyButtons[0]);

    await waitFor(() => {
      expect(screen.getByLabelText(/Reply/i)).toBeInTheDocument();
    });
  });

  it('opens edit form when Edit is clicked in all-posts view', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Show All Posts/i })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Show All Posts/i }));
    await waitFor(() => {
      expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
    });
    const postCards = screen.getAllByTestId('post-card');
    const ownPost = postCards.find((card) => within(card).queryByText(/these are too close/i));
    expect(ownPost).toBeDefined();
    const editButton = within(ownPost!).getByRole('button', { name: /Edit/i });
    await user.click(editButton);

    await waitFor(() => {
      expect(screen.getByLabelText(/Edit post/i)).toBeInTheDocument();
    });
  });

  it('hides Reply button on reply posts in all-posts view', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Show All Posts/i })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Show All Posts/i }));
    await waitFor(() => {
      expect(screen.getByText(/Thanks for the feedback/i)).toBeInTheDocument();
    });
    const postCards = screen.getAllByTestId('post-card');
    const replyPost = postCards.find((card) => within(card).queryByText(/Thanks for the feedback/i));
    expect(replyPost).toBeDefined();
    expect(within(replyPost!).queryByRole('button', { name: /Reply/i })).not.toBeInTheDocument();
  });

  describe('view toggle button group wrap layout', () => {
    // measureNaturalRowWidth clones children into a probe and reads probe.offsetWidth.
    // In jsdom all layout values are 0, so probe.offsetWidth=0 and outerEl.clientWidth=0
    // → 0+0+16 > 0 is true → both groups start in column mode by default.
    // Entry threshold (from row): leftNatural+rightNatural+16 > clientWidth → 116 > cw
    // Exit threshold (from col):  leftNatural+rightNatural+48 > clientWidth → 148 > cw
    // Hysteresis dead-zone: 116 ≤ clientWidth < 148

    let resizeCallback: (() => void) | null = null;

    beforeEach(() => {
      resizeCallback = null;
      // Override the outer beforeEach's no-op with a callback-capturing version
      // so tests can manually trigger resize events. Top-level beforeEach resets
      // back to the no-op before every test outside this block.
      vi.stubGlobal('ResizeObserver', vi.fn((cb: ResizeObserverCallback) => ({
        observe: vi.fn(() => {
          resizeCallback = () => cb([], {} as ResizeObserver);
        }),
        disconnect: vi.fn(),
      })));
    });

    it('stacks both groups in column when container is too narrow (jsdom default)', async () => {
      // offsetWidth=0, clientWidth=0 → 0+0+16 > 0 → wrapped
      renderPage();
      await waitFor(() => expect(screen.getByTestId('view-toggle-left')).toBeInTheDocument());
      expect(screen.getByTestId('view-toggle-left')).toHaveClass('flex-col');
      expect(screen.getByTestId('view-toggle-right')).toHaveClass('flex-col');
    });

    it('keeps both groups in a row when the container is wide enough', async () => {
      // probe.offsetWidth=50 per group → combined=100; clientWidth=1000 → 100+16=116 < 1000
      const offsetSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(50);
      const clientSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);

      renderPage();
      await waitFor(() => expect(screen.getByTestId('view-toggle-left')).toBeInTheDocument());
      expect(screen.getByTestId('view-toggle-left')).not.toHaveClass('flex-col');
      expect(screen.getByTestId('view-toggle-right')).not.toHaveClass('flex-col');

      offsetSpy.mockRestore();
      clientSpy.mockRestore();
    });

    it('switches to column on resize and honours hysteresis dead-zone before snapping back', async () => {
      let cw = 1000;
      const offsetSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(50);
      const clientSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => cw);

      renderPage();
      await waitFor(() => expect(screen.getByTestId('view-toggle-left')).not.toHaveClass('flex-col'));

      // Narrow below entry threshold (116 > 100 → col)
      cw = 100;
      act(() => { resizeCallback?.(); });
      await waitFor(() => expect(screen.getByTestId('view-toggle-left')).toHaveClass('flex-col'));

      // Widen into dead-zone (148 > 130 → stays col)
      cw = 130;
      act(() => { resizeCallback?.(); });
      expect(screen.getByTestId('view-toggle-left')).toHaveClass('flex-col');

      // Widen above exit threshold (148 > 200 is false → row)
      cw = 200;
      act(() => { resizeCallback?.(); });
      await waitFor(() => expect(screen.getByTestId('view-toggle-left')).not.toHaveClass('flex-col'));

      offsetSpy.mockRestore();
      clientSpy.mockRestore();
    });
  });

  describe('Delete Difficulty', () => {
    it('shows Delete Difficulty button for owner when a difficulty is selected', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Delete Difficulty/i })).toBeInTheDocument();
      });
    });

    it('hides Delete Difficulty button for mapper role', async () => {
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
      expect(screen.queryByRole('button', { name: /Delete Difficulty/i })).not.toBeInTheDocument();
    });

    it('hides Delete Difficulty button for modder role', async () => {
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
      expect(screen.queryByRole('button', { name: /Delete Difficulty/i })).not.toBeInTheDocument();
    });

    it('opens confirmation modal with difficulty name when Delete Difficulty is clicked', async () => {
      renderPage();
      const user = userEvent.setup();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Delete Difficulty/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /Delete Difficulty/i }));
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /Delete Difficulty/i })).toBeInTheDocument();
      });
      const dialog = screen.getByRole('dialog', { name: /Delete Difficulty/i });
      expect(within(dialog).getByText('Hard')).toBeInTheDocument();
      expect(within(dialog).getByText(/permanently remove all its sections/i)).toBeInTheDocument();
    });

    it('cancels and closes modal without calling delete', async () => {
      renderPage();
      const user = userEvent.setup();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Delete Difficulty/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /Delete Difficulty/i }));
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /Delete Difficulty/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /Cancel/i }));
      expect(screen.queryByRole('dialog', { name: /Delete Difficulty/i })).not.toBeInTheDocument();
      expect(mockDeleteDifficulty).not.toHaveBeenCalled();
    });

    it('calls delete mutation and closes modal on confirm', async () => {
      renderPage();
      const user = userEvent.setup();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Delete Difficulty/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /Delete Difficulty/i }));
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /Delete Difficulty/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /^Delete$/i }));
      await waitFor(() => {
        expect(mockDeleteDifficulty).toHaveBeenCalledWith('d1');
      });
      expect(screen.queryByRole('dialog', { name: /Delete Difficulty/i })).not.toBeInTheDocument();
    });

    it('shows an error toast and keeps modal open when delete fails', async () => {
      mockDeleteDifficulty.mockRejectedValueOnce(new Error('Server error'));
      renderPage();
      const user = userEvent.setup();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Delete Difficulty/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /Delete Difficulty/i }));
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /Delete Difficulty/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /^Delete$/i }));
      await waitFor(() => {
        expect(screen.getByText('Server error')).toBeInTheDocument();
      });
      expect(screen.getByRole('dialog', { name: /Delete Difficulty/i })).toBeInTheDocument();
    });
  });

  describe('Pending-deletion toggle', () => {
    const PENDING_DIFF = {
      id: 'd-pending',
      mapset_id: 'ms1',
      encrypted_name: 'enc:Insane',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      delete_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    };
    // Stable array reference — returning a new spread each call would defeat
    // the useMemo split inside MapsetPage and trigger re-render storms in
    // downstream decrypt effects.
    const WITH_PENDING = [...MOCK_DIFFICULTIES, PENDING_DIFF];

    it('shows Show-deleted toggle for owner only', async () => {
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /Show deleted difficulties/i }),
        ).toBeInTheDocument();
      });
    });

    it('hides Show-deleted toggle for mapper role', async () => {
      mockUseMyMembership.mockReturnValue({
        data: {
          id: 'member-1',
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
        expect(screen.getByText('Test Mapset')).toBeInTheDocument();
      });
      expect(
        screen.queryByRole('button', { name: /Show deleted difficulties/i }),
      ).not.toBeInTheDocument();
    });

    it('calls useDifficulties with include_pending=true when toggle is on', async () => {
      // First render — toggle off, includePending should be false (default).
      mockUseDifficulties.mockImplementation(
        (_mapsetId: string, options?: { includePending?: boolean }) => {
          // When the toggle is on, return the pending row alongside active.
          if (options?.includePending) {
            return { data: WITH_PENDING, isLoading: false };
          }
          return { data: MOCK_DIFFICULTIES, isLoading: false };
        },
      );
      renderPage();
      const user = userEvent.setup();
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /Show deleted difficulties/i }),
        ).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /Show deleted difficulties/i }));

      await waitFor(() => {
        const calls = mockUseDifficulties.mock.calls;
        expect(
          calls.some(([, opts]) => opts?.includePending === true),
        ).toBe(true);
      });
    });

    it('renders pending difficulties with a Restore button', async () => {
      mockUseDifficulties.mockImplementation(
        (_mapsetId: string, options?: { includePending?: boolean }) =>
          options?.includePending
            ? { data: WITH_PENDING, isLoading: false }
            : { data: MOCK_DIFFICULTIES, isLoading: false },
      );
      renderPage();
      const user = userEvent.setup();
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /Show deleted difficulties/i }),
        ).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /Show deleted difficulties/i }));

      const pendingList = await screen.findByTestId('pending-difficulty-list');
      expect(within(pendingList).getByRole('button', { name: /Restore/i })).toBeInTheDocument();
    });

    it('calls restore mutation and shows success toast on click', async () => {
      mockUseDifficulties.mockImplementation(
        (_mapsetId: string, options?: { includePending?: boolean }) =>
          options?.includePending
            ? { data: WITH_PENDING, isLoading: false }
            : { data: MOCK_DIFFICULTIES, isLoading: false },
      );
      renderPage();
      const user = userEvent.setup();
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /Show deleted difficulties/i }),
        ).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /Show deleted difficulties/i }));
      const pendingList = await screen.findByTestId('pending-difficulty-list');
      await user.click(within(pendingList).getByRole('button', { name: /Restore/i }));

      await waitFor(() => {
        expect(mockRestoreDifficulty).toHaveBeenCalledWith(PENDING_DIFF.id);
      });
      await waitFor(() => {
        expect(screen.getByText(/Difficulty restored/i)).toBeInTheDocument();
      });
    });

    it('surfaces buffer-full 409 detail when DELETE fails', async () => {
      const axiosError = Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: {
          status: 409,
          data: { detail: 'Pending-deletion limit reached (50 slots).' },
        },
      });
      mockDeleteDifficulty.mockRejectedValueOnce(axiosError);
      renderPage();
      const user = userEvent.setup();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Delete Difficulty/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /Delete Difficulty/i }));
      const dialog = await screen.findByRole('dialog', { name: /Delete Difficulty/i });
      await user.click(within(dialog).getByRole('button', { name: /^Delete$/i }));
      await waitFor(() => {
        expect(
          screen.getByText(/Pending-deletion limit reached/i),
        ).toBeInTheDocument();
      });
    });
  });
});
