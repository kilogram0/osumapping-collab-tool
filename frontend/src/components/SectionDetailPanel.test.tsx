import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SectionDetailPanel from './SectionDetailPanel';
import type { DecryptedSection } from './SectionList';
import type { DecryptedPost } from '../types';
import type { MemberWithUser } from '../api/endpoints';

const mockIsUnlocked = vi.fn(() => true);
const mockGetKey = vi.fn(async () => ({ key: 'mock-key' } as unknown as CryptoKey));

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

vi.mock('../utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/crypto')>();
  return {
    ...actual,
    encrypt: vi.fn(async (_key: CryptoKey, plaintext: string, _aad: string) => `enc:${plaintext}`),
    decrypt: vi.fn(async (_key: CryptoKey, ciphertext: string, _aad: string) => {
      if (ciphertext.startsWith('enc:')) return ciphertext.slice(4);
      return ciphertext;
    }),
    sectionOsuVersionAad: vi.fn((id: string, mapsetId: string) => `SectionOsuVersion|${id}|${mapsetId}`),
  };
});

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

const mockSectionVersions = vi.fn(() => ({ data: undefined, isLoading: false, error: null }));

vi.mock('../hooks/useDifficulty', () => ({
  useSectionOsuVersions: (...args: unknown[]) => mockSectionVersions(...args),
  useActivateSectionOsuVersion: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useBaseOsuVersions: vi.fn(() => ({ data: [] })),
}));

vi.mock('../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/endpoints')>();
  return {
    ...actual,
    downloadSectionOsu: vi.fn(async () => ({
      id: 'sov1',
      section_id: 's1',
      encrypted_content: 'enc:osu content',
      version: 1,
      is_active: true,
      uploaded_by: 'u1',
      created_at: '',
      updated_at: '',
    })),
  };
});

const SECTION: DecryptedSection = {
  id: 's1',
  name: 'Intro',
  startTimeMs: 0,
  endTimeMs: 30000,
  sortOrder: 0,
  assignedTo: null,
};

const POSTS: DecryptedPost[] = [
  {
    id: 'p1',
    difficulty_id: 'd1',
    author_id: 'current-user-uuid',
    parent_id: null,
    tag: 'suggestion',
    encrypted_body: 'enc:00:15:000 - too close',
    created_at: '2024-01-01T12:00:00Z',
    updated_at: '2024-01-01T12:00:00Z',
    decryptedBody: '00:15:000 - too close',
    extractedMs: 15000,
  },
  {
    id: 'p2',
    difficulty_id: 'd1',
    author_id: 'other-user-uuid',
    parent_id: null,
    tag: 'problem',
    encrypted_body: 'enc:00:45:000 - offbeat',
    created_at: '2024-01-01T13:00:00Z',
    updated_at: '2024-01-01T13:00:00Z',
    decryptedBody: '00:45:000 - offbeat',
    extractedMs: 45000,
  },
  {
    id: 'p3',
    difficulty_id: 'd1',
    author_id: 'other-user-uuid',
    parent_id: null,
    tag: 'general',
    encrypted_body: 'enc:No timestamp',
    created_at: '2024-01-01T14:00:00Z',
    updated_at: '2024-01-01T14:00:00Z',
    decryptedBody: 'No timestamp',
    extractedMs: null,
  },
];

function renderPanel(props?: Partial<React.ComponentProps<typeof SectionDetailPanel>>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SectionDetailPanel
        section={SECTION}
        posts={POSTS}
        mapsetId="ms1"
        mapsetTitle="Test Mapset"
        difficultyId="d1"
        currentUserId="current-user-uuid"
        isOwner={false}
        canEditStructure={false}
        onCreatePost={vi.fn()}
        onUpdatePost={vi.fn()}
        onDeletePost={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('SectionDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({ key: 'mock-key' } as unknown as CryptoKey);
    mockSectionVersions.mockReturnValue({ data: undefined, isLoading: false, error: null });
  });

  it('renders section name and time range', () => {
    renderPanel();
    expect(screen.getByText('Intro')).toBeInTheDocument();
    expect(screen.getByText(/00:00\.000 – 00:30\.000/i)).toBeInTheDocument();
  });

  it('shows latest upload time without username when uploader matches assignee', () => {
    mockSectionVersions.mockReturnValue({
      data: [{ id: 'v1', version: 1, uploaded_by: 'u1', created_at: '2024-06-01T10:00:00Z' }],
      isLoading: false,
      error: null,
    });
    const membersById = new Map([['u1', { user_id: 'u1', username: 'mapper1' } as MemberWithUser]]);
    renderPanel({ section: { ...SECTION, assignedTo: 'u1' }, membersById });
    expect(screen.getByText(/Latest upload:/i)).toBeInTheDocument();
    expect(screen.queryByText(/Latest upload:.*@mapper1/i)).not.toBeInTheDocument();
  });

  it('shows latest upload time with username when uploader differs from assignee', () => {
    mockSectionVersions.mockReturnValue({
      data: [{ id: 'v1', version: 1, uploaded_by: 'u2', created_at: '2024-06-01T10:00:00Z' }],
      isLoading: false,
      error: null,
    });
    const membersById = new Map([
      ['u1', { user_id: 'u1', username: 'assignee' } as MemberWithUser],
      ['u2', { user_id: 'u2', username: 'modifier' } as MemberWithUser],
    ]);
    renderPanel({ section: { ...SECTION, assignedTo: 'u1' }, membersById });
    expect(screen.getByText(/Latest upload:.*@modifier/i)).toBeInTheDocument();
  });

  it('shows latest upload with username when there is no assignee', () => {
    mockSectionVersions.mockReturnValue({
      data: [{ id: 'v1', version: 1, uploaded_by: 'u2', created_at: '2024-06-01T10:00:00Z' }],
      isLoading: false,
      error: null,
    });
    const membersById = new Map([['u2', { user_id: 'u2', username: 'modifier' } as MemberWithUser]]);
    renderPanel({ section: { ...SECTION, assignedTo: null }, membersById });
    expect(screen.getByText(/Latest upload:.*@modifier/i)).toBeInTheDocument();
  });

  it('does not show latest upload when no versions exist', () => {
    mockSectionVersions.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPanel();
    expect(screen.queryByText(/Latest upload:/i)).not.toBeInTheDocument();
  });

  it('shows post count in header', () => {
    renderPanel();
    expect(screen.getByText(/Posts \(1\)/i)).toBeInTheDocument();
  });

  it('filters posts to only those within section time range', () => {
    renderPanel();
    // p1 (15000ms) is inside [0, 30000]
    expect(screen.getByText(/too close/i)).toBeInTheDocument();
    // p2 (45000ms) is outside
    expect(screen.queryByText(/offbeat/i)).not.toBeInTheDocument();
    // p3 has no timestamp so it's not shown
    expect(screen.queryByText(/No timestamp/i)).not.toBeInTheDocument();
  });

  it('shows replies to a section post even when the reply has no timestamp', () => {
    const replyNoTimestamp: DecryptedPost = {
      id: 'r1',
      difficulty_id: 'd1',
      author_id: 'other-user-uuid',
      parent_id: 'p1',
      tag: 'general',
      encrypted_body: 'enc:looks fine to me',
      created_at: '2024-01-01T15:00:00Z',
      updated_at: '2024-01-01T15:00:00Z',
      decryptedBody: 'looks fine to me',
      extractedMs: null,
    };
    renderPanel({ posts: [...POSTS, replyNoTimestamp] });
    expect(screen.getByText(/too close/i)).toBeInTheDocument();
    expect(screen.getByText(/looks fine to me/i)).toBeInTheDocument();
  });

  it('shows replies to a section post even when the reply timestamp is outside the section', () => {
    const replyOtherSection: DecryptedPost = {
      id: 'r2',
      difficulty_id: 'd1',
      author_id: 'other-user-uuid',
      parent_id: 'p1',
      tag: 'general',
      encrypted_body: 'enc:01:30:000 - see here for reference',
      created_at: '2024-01-01T15:00:00Z',
      updated_at: '2024-01-01T15:00:00Z',
      decryptedBody: '01:30:000 - see here for reference',
      extractedMs: 90000,
    };
    renderPanel({ posts: [...POSTS, replyOtherSection] });
    expect(screen.getByText(/see here for reference/i)).toBeInTheDocument();
  });

  it('does not show replies whose root post is outside the section', () => {
    const replyToOutside: DecryptedPost = {
      id: 'r3',
      difficulty_id: 'd1',
      author_id: 'current-user-uuid',
      parent_id: 'p2',
      tag: 'general',
      encrypted_body: 'enc:fair point',
      created_at: '2024-01-01T15:00:00Z',
      updated_at: '2024-01-01T15:00:00Z',
      decryptedBody: 'fair point',
      extractedMs: null,
    };
    renderPanel({ posts: [...POSTS, replyToOutside] });
    // p2 is at 45000ms (outside the section), so its reply should not appear
    expect(screen.queryByText(/fair point/i)).not.toBeInTheDocument();
  });

  it('shows a deeply nested reply anchored to the section root', () => {
    const reply1: DecryptedPost = {
      id: 'r1',
      difficulty_id: 'd1',
      author_id: 'other-user-uuid',
      parent_id: 'p1',
      tag: 'general',
      encrypted_body: 'enc:first reply',
      created_at: '2024-01-01T15:00:00Z',
      updated_at: '2024-01-01T15:00:00Z',
      decryptedBody: 'first reply',
      extractedMs: null,
    };
    const reply2: DecryptedPost = {
      id: 'r2',
      difficulty_id: 'd1',
      author_id: 'current-user-uuid',
      parent_id: 'r1',
      tag: 'general',
      encrypted_body: 'enc:nested reply',
      created_at: '2024-01-01T15:01:00Z',
      updated_at: '2024-01-01T15:01:00Z',
      decryptedBody: 'nested reply',
      extractedMs: null,
    };
    renderPanel({ posts: [...POSTS, reply1, reply2] });
    expect(screen.getByText(/first reply/i)).toBeInTheDocument();
    expect(screen.getByText(/nested reply/i)).toBeInTheDocument();
  });

  it('collapsing a root post hides its replies and resolve events; expanding restores them', async () => {
    localStorage.clear();
    const reply: DecryptedPost = {
      id: 'r1',
      difficulty_id: 'd1',
      author_id: 'other-user-uuid',
      parent_id: 'p1',
      tag: 'general',
      encrypted_body: 'enc:looks fine to me',
      created_at: '2024-01-01T15:00:00Z',
      updated_at: '2024-01-01T15:00:00Z',
      decryptedBody: 'looks fine to me',
      extractedMs: null,
    };
    const resolveEvent: DecryptedPost = {
      id: 'rv1',
      difficulty_id: 'd1',
      author_id: 'other-user-uuid',
      parent_id: 'p1',
      tag: 'resolve',
      encrypted_body: 'enc:',
      created_at: '2024-01-01T16:00:00Z',
      updated_at: '2024-01-01T16:00:00Z',
      decryptedBody: '',
      extractedMs: null,
    };
    renderPanel({ posts: [...POSTS, reply, resolveEvent] });

    await waitFor(() => {
      expect(screen.getByText(/too close/i)).toBeInTheDocument();
      expect(screen.getByText(/looks fine to me/i)).toBeInTheDocument();
    });
    // Sanity: only the root has a collapse toggle — the reply has none.
    expect(screen.getAllByRole('button', { name: /Collapse post/i })).toHaveLength(1);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Collapse post/i }));

    // Root header stays visible; reply body and resolve event disappear.
    expect(screen.queryByText(/looks fine to me/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/marked this as resolved/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Expand post/i }));
    await waitFor(() => {
      expect(screen.getByText(/looks fine to me/i)).toBeInTheDocument();
    });
  });

  it('shows no-posts message when section has no posts', () => {
    renderPanel({ posts: [] });
    expect(screen.getByText(/No posts for this section yet/i)).toBeInTheDocument();
  });

  it('shows New Post button', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /New Post/i })).toBeInTheDocument();
  });

  it('toggles create post form', async () => {
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /New Post/i }));
    expect(screen.getByLabelText(/New post/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Hide Form/i }));
    expect(screen.queryByLabelText(/New post/i)).not.toBeInTheDocument();
  });

  it('shows upload and edit buttons when canEditStructure is true', () => {
    renderPanel({ canEditStructure: true, role: 'owner' });
    expect(screen.getByText('Upload .osu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit/i })).toBeInTheDocument();
  });

  it('hides upload and edit buttons when canEditStructure is false', () => {
    renderPanel({ canEditStructure: false });
    expect(screen.queryByText('Upload .osu')).not.toBeInTheDocument();
    // Section-level Edit button is hidden; PostCard-level Edit buttons may still appear
    const header = screen.getByTestId('section-detail-panel').querySelector('.flex.items-start');
    expect(header).toBeTruthy();
    expect(header!.textContent).not.toMatch(/Edit/);
  });

  it('shows download and version history buttons', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /Download \.osu/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Version History/i })).toBeInTheDocument();
  });

  it('calls onEditSection when Edit is clicked', async () => {
    const onEditSection = vi.fn();
    renderPanel({ canEditStructure: true, onEditSection });
    const user = userEvent.setup();
    // The section-level Edit button is in the panel header; PostCards also have Edit buttons.
    // Use getAllBy and click the first one (section header renders before posts).
    const editButtons = screen.getAllByRole('button', { name: /Edit/i });
    await user.click(editButtons[0]);
    expect(onEditSection).toHaveBeenCalledTimes(1);
    expect(onEditSection).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('calls onCreatePost when submitting a new post', async () => {
    const onCreatePost = vi.fn();
    renderPanel({ onCreatePost });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /New Post/i }));

    const textarea = screen.getByLabelText(/New post/i);
    await user.type(textarea, '01:00:000 - great rhythm');

    await user.click(screen.getByRole('button', { name: /^Post$/i }));

    await waitFor(() => {
      expect(onCreatePost).toHaveBeenCalledTimes(1);
    });

    const payload = onCreatePost.mock.calls[0][0];
    expect(payload.tag).toBe('general');
    expect(payload.encrypted_body).toBe('enc:01:00:000 - great rhythm');
  });

  describe('Delete section button', () => {
    it('is visible to the mapset owner', () => {
      renderPanel({ isOwner: true, onDeleteSection: vi.fn() });
      const header = screen.getByTestId('section-detail-panel').querySelector('.flex.items-start');
      expect(header!.textContent).toMatch(/Delete/);
    });

    it('is hidden for mappers (canEditStructure without isOwner)', () => {
      renderPanel({
        isOwner: false,
        canEditStructure: true,
        role: 'mapper',
        onEditSection: vi.fn(),
        onDeleteSection: vi.fn(),
      });
      const header = screen.getByTestId('section-detail-panel').querySelector('.flex.items-start');
      // Edit is visible to mappers; Delete is not.
      expect(header!.textContent).toMatch(/Edit/);
      expect(header!.textContent).not.toMatch(/Delete/);
    });

    it('does nothing when the user cancels the confirm dialog', async () => {
      const onDeleteSection = vi.fn();
      window.confirm = vi.fn(() => false);
      renderPanel({ isOwner: true, onDeleteSection });
      const user = userEvent.setup();
      const header = screen.getByTestId('section-detail-panel').querySelector('.flex.items-start')!;
      const deleteButton = Array.from(header.querySelectorAll('button')).find(
        (b) => b.textContent === 'Delete',
      )!;
      await user.click(deleteButton);
      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(onDeleteSection).not.toHaveBeenCalled();
    });

    it('calls onDeleteSection with the section when confirmed', async () => {
      const onDeleteSection = vi.fn();
      window.confirm = vi.fn(() => true);
      renderPanel({ isOwner: true, onDeleteSection });
      const user = userEvent.setup();
      const header = screen.getByTestId('section-detail-panel').querySelector('.flex.items-start')!;
      const deleteButton = Array.from(header.querySelectorAll('button')).find(
        (b) => b.textContent === 'Delete',
      )!;
      await user.click(deleteButton);
      await waitFor(() => {
        expect(onDeleteSection).toHaveBeenCalledTimes(1);
      });
      expect(onDeleteSection).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    });
  });

  it('calls onDeletePost when Delete is clicked', async () => {
    const onDeletePost = vi.fn();
    window.confirm = vi.fn(() => true);
    renderPanel({ isOwner: true, onDeletePost });
    const user = userEvent.setup();
    const deleteButtons = screen.getAllByRole('button', { name: /Delete/i });
    await user.click(deleteButtons[0]);

    await waitFor(() => {
      expect(onDeletePost).toHaveBeenCalledTimes(1);
    });
  });
});
