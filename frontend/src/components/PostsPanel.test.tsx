import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostsPanel from './PostsPanel';
import type { DecryptedPost } from '../types';

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
    postFieldAad: vi.fn((postId: string, mapsetId: string) => `Post|${postId}|${mapsetId}`),
  };
});

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

function post(overrides: Partial<DecryptedPost> & { id: string }): DecryptedPost {
  return {
    difficulty_id: 'd1',
    author_id: 'current-user-uuid',
    parent_id: null,
    tag: 'suggestion',
    encrypted_body: 'enc:',
    created_at: '2024-01-01T12:00:00Z',
    updated_at: '2024-01-01T12:00:00Z',
    decryptedBody: '',
    extractedMs: null,
    ...overrides,
  };
}

const ROOT = post({ id: 'p1', tag: 'problem', decryptedBody: '00:15:000 - too close' });

function renderPanel(props?: Partial<React.ComponentProps<typeof PostsPanel>>) {
  return render(
    <PostsPanel
      posts={[ROOT]}
      mapsetId="ms1"
      difficultyId="d1"
      currentUserId="current-user-uuid"
      isOwner={false}
      canPost
      showAllPostsActive
      showOnlyUnresolved={false}
      onSelectAllPosts={vi.fn()}
      onToggleUnresolved={vi.fn()}
      onCreatePost={vi.fn().mockResolvedValue(undefined)}
      onUpdatePost={vi.fn().mockResolvedValue(undefined)}
      onDeletePost={vi.fn()}
      {...props}
    />,
  );
}

describe('PostsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({ key: 'mock-key' } as unknown as CryptoKey);
  });

  it('renders the always-open create form without a New Post toggle', () => {
    renderPanel();
    expect(screen.getByLabelText(/New post/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New Post/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Hide Form/i })).not.toBeInTheDocument();
  });

  it('hides the create form for ghost members (canPost=false)', () => {
    renderPanel({ canPost: false });
    expect(screen.queryByLabelText(/New post/i)).not.toBeInTheDocument();
  });

  it.each([
    ['Problem', 'problem'],
    ['Suggestion', 'suggestion'],
    ['Praise', 'praise'],
    ['Note', 'general'],
  ])('clicking the %s button submits a post with tag %s', async (label, tag) => {
    const onCreatePost = vi.fn().mockResolvedValue(undefined);
    renderPanel({ onCreatePost });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/New post/i), '00:01:000 - text');
    // The four tag buttons live in the always-open main form (not on a PostCard).
    const form = screen.getByLabelText(/New post/i).closest('form')!;
    await user.click(within(form).getByRole('button', { name: new RegExp(`^${label}$`, 'i') }));

    await waitFor(() => expect(onCreatePost).toHaveBeenCalledTimes(1));
    expect(onCreatePost.mock.calls[0][0].tag).toBe(tag);
  });

  it('opening a reply does not remove the always-open main form', async () => {
    renderPanel();
    const user = userEvent.setup();

    expect(screen.getAllByLabelText(/New post/i)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /^Reply$/i }));

    // A reply textarea appears, and the main "New post" textarea is still there.
    await waitFor(() => expect(screen.getByLabelText(/^Reply$/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/New post/i)).toBeInTheDocument();
  });

  it('filters out resolved roots when showOnlyUnresolved is set', () => {
    const resolveReply = post({
      id: 'rv1',
      parent_id: 'p1',
      tag: 'resolve',
      decryptedBody: '',
    });
    const { rerender } = renderPanel({ posts: [ROOT, resolveReply], showOnlyUnresolved: false });
    expect(screen.getByText(/too close/i)).toBeInTheDocument();

    rerender(
      <PostsPanel
        posts={[ROOT, resolveReply]}
        mapsetId="ms1"
        difficultyId="d1"
        currentUserId="current-user-uuid"
        isOwner={false}
        canPost
        showAllPostsActive
        showOnlyUnresolved
        onSelectAllPosts={vi.fn()}
        onToggleUnresolved={vi.fn()}
        onCreatePost={vi.fn()}
        onUpdatePost={vi.fn()}
        onDeletePost={vi.fn()}
      />,
    );
    expect(screen.queryByText(/too close/i)).not.toBeInTheDocument();
  });

  it('fires the toggle callbacks from the header buttons', async () => {
    const onSelectAllPosts = vi.fn();
    const onToggleUnresolved = vi.fn();
    renderPanel({ onSelectAllPosts, onToggleUnresolved });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Show All Posts/i }));
    await user.click(screen.getByRole('button', { name: /Show Only Unresolved/i }));
    expect(onSelectAllPosts).toHaveBeenCalledTimes(1);
    expect(onToggleUnresolved).toHaveBeenCalledTimes(1);
  });
});
