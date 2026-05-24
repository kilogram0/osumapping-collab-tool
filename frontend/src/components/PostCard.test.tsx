import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostCard from './PostCard';
import type { Post } from '../api/endpoints';

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
    decrypt: vi.fn(async (_key: CryptoKey, ciphertext: string, _aad: string) => {
      if (ciphertext.startsWith('enc:')) return ciphertext.slice(4);
      return ciphertext;
    }),
    postFieldAad: vi.fn((postId: string, mapsetId: string) => `Post|${postId}|${mapsetId}`),
  };
});

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

const BASE_POST: Post = {
  id: 'p1',
  difficulty_id: 'd1',
  author_id: 'author-uuid',
  parent_id: null,
  tag: 'suggestion',
  encrypted_body: 'enc:00:46:140 (2,3,4) - these are too close',
  created_at: '2024-01-01T12:00:00Z',
  updated_at: '2024-01-01T12:00:00Z',
};

function renderCard(props?: Partial<React.ComponentProps<typeof PostCard>>) {
  return render(
    <PostCard
      post={BASE_POST}
      mapsetId="ms1"
      currentUserId="current-user-uuid"
      isOwner={false}
      {...props}
    />,
  );
}

const storageStore: Record<string, string> = {};

describe('PostCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({ key: 'mock-key' } as unknown as CryptoKey);
    // Reset storage store
    for (const k in storageStore) delete storageStore[k];
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storageStore[k] ?? null,
      setItem: (k: string, v: string) => { storageStore[k] = v; },
      removeItem: (k: string) => { delete storageStore[k]; },
      key: (i: number) => Object.keys(storageStore)[i] ?? null,
      get length() { return Object.keys(storageStore).length; },
      clear: () => { for (const k in storageStore) delete storageStore[k]; },
    });
  });

  it('renders tag badge and author label', async () => {
    renderCard();
    await act(async () => {});
    expect(screen.getByText('Suggestion')).toBeInTheDocument();
    expect(screen.getByText(/User author-/i)).toBeInTheDocument();
  });

  it('marks the current user as "(you)"', async () => {
    renderCard({ post: { ...BASE_POST, author_id: 'current-user-uuid' } });
    await act(async () => {});
    expect(screen.getByText(/\(you\)/i)).toBeInTheDocument();
  });

  it('uses author profile when supplied', async () => {
    renderCard({ author: { username: 'mapper42', avatar_url: 'https://example.com/a.png' } });
    await act(async () => {});
    expect(screen.getByText('mapper42')).toBeInTheDocument();
  });

  it('decrypts and displays body with linkified timestamps', async () => {
    renderCard();
    await act(async () => {});
    await waitFor(() => {
      expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
    });
    const links = screen.getAllByRole('link', { name: /00:46:140 \(2,3,4\)/i });
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0]).toHaveAttribute('href', 'osu://edit/00:46:140%20(2%2C3%2C4)');
  });

  it('shows encrypted placeholder when locked', async () => {
    mockIsUnlocked.mockReturnValue(false);
    renderCard();
    await act(async () => {});
    expect(screen.getByText(/🔒 Encrypted post/i)).toBeInTheDocument();
  });

  it('shows reply, edit, and delete buttons for author', async () => {
    const onReply = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    renderCard({
      post: { ...BASE_POST, author_id: 'current-user-uuid' },
      onReply,
      onEdit,
      onDelete,
    });
    await act(async () => {});
    expect(screen.getByRole('button', { name: /Reply/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete/i })).toBeInTheDocument();
  });

  it('shows delete but not edit for owner on another user\'s post', async () => {
    const onDelete = vi.fn();
    renderCard({ isOwner: true, onDelete });
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /Edit/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete/i })).toBeInTheDocument();
  });

  it('hides edit/delete for non-author non-owner', async () => {
    renderCard();
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /Edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/i })).not.toBeInTheDocument();
  });

  it('calls onReply when Reply is clicked', async () => {
    const onReply = vi.fn();
    renderCard({ onReply });
    await act(async () => {});
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reply/i }));
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  it('calls onDelete when Delete is clicked', async () => {
    const onDelete = vi.fn();
    renderCard({ isOwner: true, onDelete });
    await act(async () => {});
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Delete/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('p1');
  });

  it('collapses and expands on toggle button click', async () => {
    renderCard();
    await act(async () => {});
    await waitFor(() => {
      expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const toggle = screen.getByRole('button', { name: /Collapse post/i });
    await user.click(toggle);

    expect(screen.queryByText(/these are too close/i)).not.toBeInTheDocument();

    const expand = screen.getByRole('button', { name: /Expand post/i });
    await user.click(expand);

    await waitFor(() => {
      expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
    });
  });

  it('persists collapse state to localStorage', async () => {
    renderCard({ currentUserId: 'u1' });
    await act(async () => {});
    await waitFor(() => {
      expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Collapse post/i }));

    expect(localStorage.getItem('post-collapsed:u1:p1')).toBe('true');
  });

  it('restores collapse state from localStorage', async () => {
    localStorage.setItem('post-collapsed:u1:p1', 'true');
    renderCard({ currentUserId: 'u1' });
    await act(async () => {});
    expect(screen.queryByText(/these are too close/i)).not.toBeInTheDocument();
  });

  it('shows failure state when decrypt fails', async () => {
    const { decrypt } = await import('../utils/crypto');
    vi.mocked(decrypt).mockRejectedValueOnce(new Error('aad mismatch'));
    renderCard();
    await act(async () => {});
    await waitFor(() => {
      expect(screen.getByText(/Failed to decrypt post/i)).toBeInTheDocument();
    });
  });

  it('uses provided decryptedBody without calling decrypt', async () => {
    const { decrypt } = await import('../utils/crypto');
    renderCard({ decryptedBody: 'plaintext body without timestamps' });
    await act(async () => {});
    expect(screen.getByText(/plaintext body without timestamps/i)).toBeInTheDocument();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('shows green border when isResolved is true on a root post', async () => {
    renderCard({ isResolved: true });
    await act(async () => {});
    const card = screen.getByTestId('post-card');
    expect(card.className).toContain('border-green-600');
  });

  it('does not show green border when isResolved is false', async () => {
    renderCard({ isResolved: false });
    await act(async () => {});
    const card = screen.getByTestId('post-card');
    expect(card.className).not.toContain('border-green-600');
  });

});
