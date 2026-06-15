import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    getPassphrase: vi.fn(() => null),
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

vi.mock('../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/endpoints')>();
  return {
    ...actual,
    // Reject so the background hitobject scan treats all sections as pending
    // without making real network calls in tests.
    downloadSectionOsu: vi.fn().mockRejectedValue(new Error('no osu in tests')),
    downloadBaseOsu: vi.fn().mockRejectedValue(new Error('no base osu in tests')),
    fetchDifficultyDetail: vi.fn().mockRejectedValue(new Error('use hook mock')),
  };
});

vi.mock('../components/MergedDownloadButton', () => ({
  default: () => <button type="button">Download Full Difficulty (.osu)</button>,
}));

const mockResourcesPanelProps = vi.fn();
vi.mock('../components/ResourcesPanel', () => ({
  default: (props: Record<string, unknown>) => {
    mockResourcesPanelProps(props);
    return null;
  },
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

// Mutable so an Edit Mapset save can mutate it and the next render reflects the
// change — `useMapset` below reads this live (mock-prefixed for vi.mock hoisting).
let mockCurrentMapset: typeof MOCK_MAPSET = MOCK_MAPSET;
const mockUpdateMapset = vi.fn();

const mockCreatePost = vi.fn().mockResolvedValue({});
const mockUpdatePost = vi.fn().mockResolvedValue({});
const mockDeletePost = vi.fn().mockResolvedValue({});
const mockDeleteDifficulty = vi.fn().mockResolvedValue({});
const mockRestoreDifficulty = vi.fn().mockResolvedValue({});
const mockDeleteSection = vi.fn().mockResolvedValue({});
const mockUpdateSection = vi.fn().mockResolvedValue({});
const mockCreateSection = vi.fn().mockResolvedValue({});
const mockUseDifficulties = vi.fn(() => ({ data: MOCK_DIFFICULTIES, isLoading: false }));
const mockUseDifficultyDetail = vi.fn(() => ({ data: MOCK_DIFFICULTY_DETAIL, isLoading: false }));

const mockRedistributeForMerge = vi.fn().mockResolvedValue({ movedCount: 0 });
const mockRedistributeForShorten = vi.fn().mockResolvedValue({ movedCount: 0 });

vi.mock('../utils/sectionRedistribute', () => ({
  redistributeForMerge: (...args: unknown[]) => mockRedistributeForMerge(...args),
  redistributeForShorten: (...args: unknown[]) => mockRedistributeForShorten(...args),
  redistributeForDelete: vi.fn().mockResolvedValue({ movedCount: 0 }),
  hasSectionOsu: vi.fn().mockResolvedValue(false),
}));

vi.mock('../hooks/useMapset', () => ({
  useMapset: () => ({
    data: mockCurrentMapset,
    isLoading: false,
    isError: false,
  }),
  useMapsets: () => ({
    data: [mockCurrentMapset],
    isLoading: false,
    isError: false,
  }),
  useUpdateMapset: () => ({ mutateAsync: mockUpdateMapset, isPending: false }),
  useMyMembership: (_mapsetId: string) => mockUseMyMembership(),
  useMembers: (_mapsetId: string, _enabled?: boolean) => ({
    data: [],
    isLoading: false,
    isError: false,
  }),
  useResources: () => ({ data: [] }),
  useCreateResource: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteResource: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useInviteMember: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateMemberRole: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoveMember: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('../hooks/useDifficulty', () => ({
  useDifficulties: (mapsetId: string, options?: { includePending?: boolean }) =>
    mockUseDifficulties(mapsetId, options),
  useDifficultyDetail: () => mockUseDifficultyDetail(),
  useCreateDifficulty: () => ({
    mutateAsync: vi.fn(),
  }),
  useCreateSection: () => ({
    mutateAsync: mockCreateSection,
  }),
  useUpdateSection: () => ({
    mutateAsync: mockUpdateSection,
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
    mutateAsync: mockDeleteSection,
  }),
  useAssignSection: () => ({
    mutateAsync: vi.fn(),
  }),
  useSectionOsuVersions: () => ({
    data: undefined,
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

/**
 * Opens the difficulty dropdown so its inner rows — (Add Difficulty), each
 * difficulty's rename/delete icons, and the deleted-difficulty rows — become
 * queryable. The dropdown is closed by default.
 */
async function openDifficultyMenu(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Toggle difficulty list/i })).toBeInTheDocument(),
  );
  await user.click(screen.getByRole('button', { name: /Toggle difficulty list/i }));
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
    mockDeleteSection.mockReset();
    mockDeleteSection.mockResolvedValue({});
    mockUpdateSection.mockReset();
    mockUpdateSection.mockResolvedValue({});
    mockCreateSection.mockReset();
    mockCreateSection.mockResolvedValue({});
    mockRedistributeForMerge.mockReset();
    mockRedistributeForMerge.mockResolvedValue({ movedCount: 0 });
    mockRedistributeForShorten.mockReset();
    mockRedistributeForShorten.mockResolvedValue({ movedCount: 0 });
    mockUseDifficulties.mockReturnValue({ data: MOCK_DIFFICULTIES, isLoading: false });
    mockUseDifficultyDetail.mockReturnValue({ data: MOCK_DIFFICULTY_DETAIL, isLoading: false });
    mockCurrentMapset = MOCK_MAPSET;
    mockUpdateMapset.mockReset();
    // Merge the PATCH payload into the live mapset so the page re-renders with
    // the new values once the modal closes (mirrors a refetch after invalidate).
    mockUpdateMapset.mockImplementation(async (payload) => {
      mockCurrentMapset = {
        ...mockCurrentMapset,
        ...payload,
        updated_at: new Date().toISOString(),
      };
      return mockCurrentMapset;
    });
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

  afterEach(() => {
    vi.unstubAllGlobals();
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
    // Song length renders on the title line as "-  04:05" (nbsp-padded).
    expect(screen.getByText(/04:05/)).toBeInTheDocument();
  });

  it('shows Add Difficulty option for owner', async () => {
    renderPage();
    const user = userEvent.setup();
    await openDifficultyMenu(user);
    expect(screen.getByRole('button', { name: /\(Add Difficulty\)/i })).toBeInTheDocument();
  });

  it('opens create difficulty modal when Add Difficulty is clicked', async () => {
    renderPage();
    const user = userEvent.setup();
    await openDifficultyMenu(user);
    await user.click(screen.getByRole('button', { name: /\(Add Difficulty\)/i }));
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

  it('copies assignments to the clipboard from the toolbar button', async () => {
    renderPage();
    const user = userEvent.setup();
    // Define after setup(): userEvent installs its own clipboard stub on setup.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Copy Assignments/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Copy Assignments/i }));
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('shows Copy Assignments disabled when the difficulty has no sections', async () => {
    mockUseDifficultyDetail.mockReturnValue({
      data: { ...MOCK_DIFFICULTY_DETAIL, sections: [] },
      isLoading: false,
    });
    renderPage();
    const btn = await screen.findByRole('button', { name: /Copy Assignments/i });
    expect(btn).toBeDisabled();
  });

  it('shows the full-difficulty Download button when a difficulty is selected', async () => {
    renderPage();
    expect(
      await screen.findByRole('button', { name: /Download Full Difficulty/i }),
    ).toBeInTheDocument();
  });

  it('hides the full-difficulty Download button when no difficulty is selected', async () => {
    mockUseDifficulties.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    // No difficulties → nothing selected → the merged-download button (and the
    // rest of the per-difficulty toolbar) must not mount.
    await screen.findByText(/No difficulties/i);
    expect(
      screen.queryByRole('button', { name: /Download Full Difficulty/i }),
    ).not.toBeInTheDocument();
  });

  it('shows Add Difficulty but hides owner-only buttons for mapper role', async () => {
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
    const user = userEvent.setup();
    await openDifficultyMenu(user);
    expect(screen.getByRole('button', { name: /\(Add Difficulty\)/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add Section/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rename Difficulty/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete Difficulty/i })).not.toBeInTheDocument();
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

  it('passes isOwner=true to ResourcesPanel for real owner', async () => {
    mockResourcesPanelProps.mockClear();
    renderPage();
    await waitFor(() => expect(screen.getByText('Test Mapset')).toBeInTheDocument());
    expect(mockResourcesPanelProps).toHaveBeenCalledWith(
      expect.objectContaining({ isOwner: true }),
    );
  });

  it('passes isOwner=false to ResourcesPanel for mapper role', async () => {
    mockResourcesPanelProps.mockClear();
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
    await waitFor(() => expect(screen.getByText('Test Mapset')).toBeInTheDocument());
    expect(mockResourcesPanelProps).toHaveBeenCalledWith(
      expect.objectContaining({ isOwner: false }),
    );
  });

  it('passes isOwner=false to ResourcesPanel when owner emulates mapper role', async () => {
    mockResourcesPanelProps.mockClear();
    renderPage();
    await waitFor(() => expect(screen.getByText('Test Mapset')).toBeInTheDocument());

    // At render time the owner has isOwner=true.
    expect(mockResourcesPanelProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ isOwner: true }),
    );

    // Open the Manage menu, then the Manage Members modal, and select mapper in
    // the emulate-role combobox.
    await userEvent.click(screen.getByRole('button', { name: /^Manage$/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /manage members/i }));
    const emulateSelect = await screen.findByRole('combobox', { name: /preview/i });
    await userEvent.selectOptions(emulateSelect, 'mapper');

    await waitFor(() =>
      expect(mockResourcesPanelProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ isOwner: false }),
      ),
    );
  });

  it('shows a preview banner while emulating and clears it on exit', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Test Mapset')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^Manage$/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /manage members/i }));
    const emulateSelect = await screen.findByRole('combobox', { name: /preview/i });
    await userEvent.selectOptions(emulateSelect, 'mapper');

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/mapper/i);

    await userEvent.click(within(banner).getByRole('button', { name: /exit preview/i }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

    // After exiting the preview, ResourcesPanel should see isOwner=true again.
    await waitFor(() =>
      expect(mockResourcesPanelProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ isOwner: true }),
      ),
    );
  });

  it('shows Show All Posts toggle', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Show All Posts/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Section View/i })).not.toBeInTheDocument();
  });

  it('defaults to all-posts view on load without any button click', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Nice map overall/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
  });

  it('clicking a timeline marker in section mode switches to the section containing the post', async () => {
    vi.stubGlobal('scrollIntoView', vi.fn());
    HTMLElement.prototype.scrollIntoView = vi.fn();

    renderPage();
    const user = userEvent.setup();

    // Enter s1 section view
    await waitFor(() => expect(screen.getByTestId('timeline-section-s1')).toBeInTheDocument());
    await user.click(screen.getByTestId('timeline-section-s1'));
    await waitFor(() => expect(screen.getByTestId('section-detail-panel')).toBeInTheDocument());

    // p1 has timestamp 00:46:140 → 46140ms, which falls in s2 (30000–60000ms)
    const marker = await screen.findByTestId('timeline-marker-p1');
    await user.click(marker);

    // Must switch to s2, not exit to all-posts view
    await waitFor(() => expect(screen.getByTestId('section-detail-panel')).toBeInTheDocument());
    expect(within(screen.getByTestId('section-detail-panel')).getByRole('heading', { name: /Kiai 1/i })).toBeInTheDocument();

    // Target post wrapper must carry the flash class
    const postWrapper = document.getElementById('post-p1');
    expect(postWrapper).not.toBeNull();
    expect(postWrapper!.classList.contains('post-flash')).toBe(true);
  });

  it('clicking a timeline marker in show-all mode keeps all-posts view and flashes the target post', async () => {
    vi.stubGlobal('scrollIntoView', vi.fn());
    HTMLElement.prototype.scrollIntoView = vi.fn();

    renderPage();
    const user = userEvent.setup();

    // Stay in show-all mode (no section selected)
    await waitFor(() => expect(screen.getByTestId('timeline-marker-p1')).toBeInTheDocument());
    expect(screen.queryByTestId('section-detail-panel')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('timeline-marker-p1'));

    // Must stay in all-posts view
    await waitFor(() => expect(screen.queryByTestId('section-detail-panel')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/these are too close/i)).toBeInTheDocument());

    const postWrapper = document.getElementById('post-p1');
    expect(postWrapper).not.toBeNull();
    expect(postWrapper!.classList.contains('post-flash')).toBe(true);
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

  it('resets to all-posts view when switching difficulties', async () => {
    mockUseDifficulties.mockReturnValue({
      data: [
        ...MOCK_DIFFICULTIES,
        {
          id: 'd2',
          mapset_id: 'ms1',
          encrypted_name: 'enc:Normal',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
      isLoading: false,
    });

    renderPage();
    const user = userEvent.setup();

    // Click a section to enter section view
    await waitFor(() => {
      expect(screen.getByTestId('timeline-section-s1')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('timeline-section-s1'));
    await waitFor(() => {
      expect(screen.getByTestId('section-detail-panel')).toBeInTheDocument();
    });

    // Switch difficulty — should reset to all-posts view
    await openDifficultyMenu(user);
    await user.click(screen.getByRole('option', { name: /Normal/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('section-detail-panel')).not.toBeInTheDocument();
    });
    expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
  });

  it('clicking Show All Posts from section view hides the section panel and shows posts', async () => {
    renderPage();
    const user = userEvent.setup();

    // Enter section view
    await waitFor(() => {
      expect(screen.getByTestId('timeline-section-s1')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('timeline-section-s1'));
    await waitFor(() => {
      expect(screen.getByTestId('section-detail-panel')).toBeInTheDocument();
    });

    // Return to all-posts via the button
    await user.click(screen.getByRole('button', { name: /Show All Posts/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('section-detail-panel')).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Nice map overall/i)).toBeInTheDocument();
    expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
  });

  it('creates a new post through the always-open all-posts form', async () => {
    renderPage();
    // The create form is always open in the posts box — no "New Post" toggle.
    const textarea = await screen.findByLabelText(/New post/i);
    const user = userEvent.setup();
    await user.type(textarea, '01:00:000 - great rhythm');

    await user.click(screen.getByRole('button', { name: /^Note$/i }));

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


  describe('Delete Difficulty', () => {
    it('shows the Delete Difficulty row icon for owner inside the dropdown', async () => {
      renderPage();
      const user = userEvent.setup();
      await openDifficultyMenu(user);
      expect(screen.getByRole('button', { name: /Delete Difficulty: Hard/i })).toBeInTheDocument();
    });

    it('hides Delete Difficulty for mapper role', async () => {
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
      const user = userEvent.setup();
      await openDifficultyMenu(user);
      expect(screen.getByRole('button', { name: /\(Add Difficulty\)/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Delete Difficulty/i })).not.toBeInTheDocument();
    });

    it('hides Delete Difficulty for modder role', async () => {
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
      const user = userEvent.setup();
      await openDifficultyMenu(user);
      expect(screen.queryByRole('button', { name: /Delete Difficulty/i })).not.toBeInTheDocument();
    });

    it('opens confirmation modal with difficulty name when Delete Difficulty is clicked', async () => {
      renderPage();
      const user = userEvent.setup();
      await openDifficultyMenu(user);
      await user.click(screen.getByRole('button', { name: /Delete Difficulty: Hard/i }));
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
      await openDifficultyMenu(user);
      await user.click(screen.getByRole('button', { name: /Delete Difficulty: Hard/i }));
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
      await openDifficultyMenu(user);
      await user.click(screen.getByRole('button', { name: /Delete Difficulty: Hard/i }));
      const dialog = await screen.findByRole('dialog', { name: /Delete Difficulty/i });
      await user.click(within(dialog).getByRole('button', { name: /^Delete$/i }));
      await waitFor(() => {
        expect(mockDeleteDifficulty).toHaveBeenCalledWith('d1');
      });
      expect(screen.queryByRole('dialog', { name: /Delete Difficulty/i })).not.toBeInTheDocument();
    });

    it('shows an error toast and keeps modal open when delete fails', async () => {
      mockDeleteDifficulty.mockRejectedValueOnce(new Error('Server error'));
      renderPage();
      const user = userEvent.setup();
      await openDifficultyMenu(user);
      await user.click(screen.getByRole('button', { name: /Delete Difficulty: Hard/i }));
      const dialog = await screen.findByRole('dialog', { name: /Delete Difficulty/i });
      await user.click(within(dialog).getByRole('button', { name: /^Delete$/i }));
      await waitFor(() => {
        expect(screen.getByText('Server error')).toBeInTheDocument();
      });
      expect(screen.getByRole('dialog', { name: /Delete Difficulty/i })).toBeInTheDocument();
    });
  });

  describe('Deleted difficulties', () => {
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

    it('fetches pending difficulties (includePending=true) for owners', async () => {
      renderPage();
      await waitFor(() => {
        const calls = mockUseDifficulties.mock.calls;
        expect(calls.some(([, opts]) => opts?.includePending === true)).toBe(true);
      });
    });

    it('does not fetch pending difficulties for mapper role', async () => {
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
      const calls = mockUseDifficulties.mock.calls;
      expect(calls.every(([, opts]) => opts?.includePending !== true)).toBe(true);
    });

    it('lists deleted difficulties with a Restore icon inside the dropdown', async () => {
      mockUseDifficulties.mockReturnValue({ data: WITH_PENDING, isLoading: false });
      renderPage();
      const user = userEvent.setup();
      await openDifficultyMenu(user);
      expect(screen.getByRole('button', { name: /Restore: Insane/i })).toBeInTheDocument();
    });

    it('calls restore mutation and shows success toast on click', async () => {
      mockUseDifficulties.mockReturnValue({ data: WITH_PENDING, isLoading: false });
      renderPage();
      const user = userEvent.setup();
      await openDifficultyMenu(user);
      await user.click(screen.getByRole('button', { name: /Restore: Insane/i }));

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
      await openDifficultyMenu(user);
      await user.click(screen.getByRole('button', { name: /Delete Difficulty: Hard/i }));
      const dialog = await screen.findByRole('dialog', { name: /Delete Difficulty/i });
      await user.click(within(dialog).getByRole('button', { name: /^Delete$/i }));
      await waitFor(() => {
        expect(
          screen.getByText(/Pending-deletion limit reached/i),
        ).toBeInTheDocument();
      });
    });
  });

  describe('Merge section', () => {
    async function openSectionPanel() {
      const user = userEvent.setup();
      await waitFor(() => expect(screen.getByTestId('timeline-section-s1')).toBeInTheDocument());
      await user.click(screen.getByTestId('timeline-section-s1'));
      await waitFor(() => expect(screen.getByTestId('section-detail-panel')).toBeInTheDocument());
      return user;
    }

    it('shows success toast when delete 404s (next already gone concurrently)', async () => {
      mockDeleteSection.mockRejectedValueOnce(
        Object.assign(new Error('Not found'), {
          isAxiosError: true,
          response: { status: 404 },
        }),
      );
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));

      renderPage();
      const user = await openSectionPanel();

      await user.click(screen.getByRole('button', { name: /Manage Section/i }));
      await user.click(screen.getByRole('menuitem', { name: /Merge with next/i }));

      await waitFor(() => {
        expect(screen.getByText(/Sections merged/i)).toBeInTheDocument();
      });
    });

    it('shows partial-failure toast (not success) when update step fails', async () => {
      mockUpdateSection.mockRejectedValueOnce(new Error('Server error'));
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));

      renderPage();
      const user = await openSectionPanel();

      await user.click(screen.getByRole('button', { name: /Manage Section/i }));
      await user.click(screen.getByRole('menuitem', { name: /Merge with next/i }));

      await waitFor(() => {
        expect(screen.getByText(/may be inconsistent/i)).toBeInTheDocument();
      });
      expect(screen.queryByText(/Sections merged/i)).not.toBeInTheDocument();
      // delete must not run when update fails — step-order contract
      expect(mockDeleteSection).not.toHaveBeenCalled();
    });

    it('shows err.message toast (not partial-failure) when redistribute step fails', async () => {
      mockRedistributeForMerge.mockRejectedValueOnce(new Error('Redistribute failed'));
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));

      renderPage();
      const user = await openSectionPanel();

      await user.click(screen.getByRole('button', { name: /Manage Section/i }));
      await user.click(screen.getByRole('menuitem', { name: /Merge with next/i }));

      await waitFor(() => {
        expect(screen.getByText(/Redistribute failed/i)).toBeInTheDocument();
      });
      expect(screen.queryByText(/may be inconsistent/i)).not.toBeInTheDocument();
      // no server writes landed, so update and delete must not have been called
      expect(mockUpdateSection).not.toHaveBeenCalled();
      expect(mockDeleteSection).not.toHaveBeenCalled();
    });
  });

  describe('Show only unresolved filter', () => {
    it('hides non-problem/suggestion posts when filter is toggled on', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByText(/Nice map overall/i)).toBeInTheDocument();
        expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const filterBtn = screen.getByRole('button', { name: /Show Only Unresolved/i });
      expect(filterBtn).toHaveAttribute('aria-pressed', 'false');
      await user.click(filterBtn);

      expect(filterBtn).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByText(/Nice map overall/i)).not.toBeInTheDocument();
      expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
    });

    it('restores all posts when filter is toggled off again', async () => {
      renderPage();
      await waitFor(() => expect(screen.getByText(/Nice map overall/i)).toBeInTheDocument());

      const user = userEvent.setup();
      const filterBtn = screen.getByRole('button', { name: /Show Only Unresolved/i });
      await user.click(filterBtn);
      expect(screen.queryByText(/Nice map overall/i)).not.toBeInTheDocument();

      await user.click(filterBtn);
      await waitFor(() => expect(screen.getByText(/Nice map overall/i)).toBeInTheDocument());
    });

    it('keeps problem/suggestion timeline marker visible while filter is on', async () => {
      renderPage();
      await waitFor(() => expect(screen.getByTestId('timeline-marker-p1')).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /Show Only Unresolved/i }));

      expect(screen.getByTestId('timeline-marker-p1')).toBeInTheDocument();
    });
  });

  describe('Split section', () => {
    async function openSplitModal() {
      const user = userEvent.setup();
      await waitFor(() => expect(screen.getByTestId('timeline-section-s1')).toBeInTheDocument());
      await user.click(screen.getByTestId('timeline-section-s1'));
      await waitFor(() => expect(screen.getByTestId('section-detail-panel')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Manage Section/i }));
      await user.click(screen.getByRole('menuitem', { name: /^Split$/i }));
      await waitFor(() => expect(screen.getByRole('dialog', { name: /Split Section/i })).toBeInTheDocument());
      return user;
    }

    it('closes modal and shows partial-failure toast when redistribute step fails', async () => {
      mockRedistributeForShorten.mockRejectedValueOnce(new Error('Network error'));

      renderPage();
      const user = await openSplitModal();
      const dialog = screen.getByRole('dialog', { name: /Split Section/i });

      await user.type(within(dialog).getByLabelText(/Split Time/i), '00:15:000');
      await user.type(within(dialog).getByLabelText(/Name for the Second Section/i), 'Kiai');
      await user.click(within(dialog).getByRole('button', { name: /^Split$/i }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: /Split Section/i })).not.toBeInTheDocument();
      });
      expect(screen.getByText(/may be inconsistent/i)).toBeInTheDocument();
    });

    it('keeps modal open with inline error when section create step fails', async () => {
      mockCreateSection.mockRejectedValueOnce(new Error('Create failed'));

      renderPage();
      const user = await openSplitModal();
      const dialog = screen.getByRole('dialog', { name: /Split Section/i });

      await user.type(within(dialog).getByLabelText(/Split Time/i), '00:15:000');
      await user.type(within(dialog).getByLabelText(/Name for the Second Section/i), 'Kiai');
      await user.click(within(dialog).getByRole('button', { name: /^Split$/i }));

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /Split Section/i })).toBeInTheDocument();
      });
      expect(screen.getByText(/Create failed/i)).toBeInTheDocument();
      // redistribute must not run when create fails — step-order contract
      expect(mockRedistributeForShorten).not.toHaveBeenCalled();
    });
  });

  describe('Edit Mapset', () => {
    it('opens from the Manage menu, updates the title, and clears the description on save', async () => {
      renderPage();
      const user = userEvent.setup();
      await waitFor(() => expect(screen.getByText('Test Mapset')).toBeInTheDocument());
      expect(screen.getByText('A test description')).toBeInTheDocument();

      // Open the top-level Manage dropdown, then the Edit Mapset item.
      await user.click(screen.getByRole('button', { name: /^Manage$/i }));
      await user.click(screen.getByRole('menuitem', { name: /Edit Mapset/i }));

      const dialog = await screen.findByRole('dialog', { name: /Edit Mapset/i });
      // Prefilled with the current decrypted values.
      expect(within(dialog).getByLabelText(/title/i)).toHaveValue('Test Mapset');
      expect(within(dialog).getByLabelText(/description/i)).toHaveValue('A test description');

      const titleInput = within(dialog).getByLabelText(/title/i);
      await user.clear(titleInput);
      await user.type(titleInput, 'Renamed Mapset');
      await user.clear(within(dialog).getByLabelText(/description/i));
      await user.click(within(dialog).getByRole('button', { name: /save/i }));

      await waitFor(() => expect(mockUpdateMapset).toHaveBeenCalledTimes(1));
      const payload = mockUpdateMapset.mock.calls[0][0];
      expect(payload.title).toBe('Renamed Mapset');
      // Cleared description must be sent as null (PATCH "clear it" semantics).
      expect(payload.encrypted_description).toBeNull();

      // Modal closes and the page reflects the new title with the description
      // gone — regression guard for the fulfilled-null display path.
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: /Edit Mapset/i })).not.toBeInTheDocument(),
      );
      await waitFor(() => expect(screen.getByText('Renamed Mapset')).toBeInTheDocument());
      expect(screen.queryByText('A test description')).not.toBeInTheDocument();
    });

    it('hides the Edit Mapset menu item for a modder', async () => {
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
      const user = userEvent.setup();
      await waitFor(() => expect(screen.getByText('Test Mapset')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /^Manage$/i }));
      expect(screen.queryByRole('menuitem', { name: /Edit Mapset/i })).not.toBeInTheDocument();
    });
  });
});
