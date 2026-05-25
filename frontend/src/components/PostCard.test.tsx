import { useState } from 'react';
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

  it('collapses and expands when the controlled toggle is invoked', async () => {
    function Controlled() {
      const [collapsed, setCollapsed] = useState(false);
      return (
        <PostCard
          post={BASE_POST}
          mapsetId="ms1"
          currentUserId="current-user-uuid"
          isOwner={false}
          isCollapsed={collapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
        />
      );
    }
    render(<Controlled />);
    await act(async () => {});
    await waitFor(() => {
      expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Collapse post/i }));

    expect(screen.queryByText(/these are too close/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Expand post/i }));

    await waitFor(() => {
      expect(screen.getByText(/these are too close/i)).toBeInTheDocument();
    });
  });

  it('hides the collapse button when onToggleCollapse is not provided', async () => {
    renderCard();
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /Collapse post/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Expand post/i })).not.toBeInTheDocument();
  });

  it('hides the body when isCollapsed is true', async () => {
    renderCard({ isCollapsed: true, onToggleCollapse: () => {} });
    await act(async () => {});
    expect(screen.queryByText(/these are too close/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Expand post/i })).toBeInTheDocument();
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

  it('renders image from ![alt](url) syntax', async () => {
    renderCard({ decryptedBody: 'look at this ![screenshot](https://example.com/img.png) here' });
    await act(async () => {});
    await waitFor(() => {
      const img = screen.getByAltText('screenshot');
      expect(img).toHaveAttribute('src', 'https://example.com/img.png');
    });
  });

  it('ignores non-http image URLs', async () => {
    renderCard({ decryptedBody: '![bad](javascript:alert(1))' });
    await act(async () => {});
    expect(screen.queryByAltText('bad')).not.toBeInTheDocument();
  });

  it('renders image and timestamp in the same post', async () => {
    renderCard({ decryptedBody: '00:10:000 - see ![ref](https://example.com/x.png)' });
    await act(async () => {});
    await waitFor(() => {
      expect(screen.getAllByRole('link', { name: /00:10:000/i }).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByAltText('ref')).toBeInTheDocument();
    });
  });

  it('does not treat timestamp in image alt text as a timestamp link', async () => {
    // Alt text is not content — the timestamp inside it must not produce a link or a header chip
    renderCard({ decryptedBody: '![00:10:000](https://example.com/x.png)' });
    await act(async () => {});
    await waitFor(() => {
      expect(screen.getByAltText('00:10:000')).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /00:10:000/i })).not.toBeInTheDocument();
  });

  it('does not double-render timestamp that appears inside image URL', async () => {
    renderCard({ decryptedBody: '![img](https://example.com/00:10:000/x.png)' });
    await act(async () => {});
    await waitFor(() => {
      expect(screen.getByAltText('img')).toBeInTheDocument();
    });
    // Only the header primaryTimestamp link appears — the body must NOT add a second one
    expect(screen.getAllByRole('link', { name: /00:10:000/i })).toHaveLength(1);
  });

  it('clicking an image does not collapse the post', async () => {
    renderCard({ decryptedBody: '![pic](https://example.com/img.png)' });
    await act(async () => {});
    const img = await screen.findByAltText('pic');
    const user = userEvent.setup();
    await user.click(img);
    // post body should still be visible (not collapsed)
    expect(screen.getByAltText('pic')).toBeInTheDocument();
  });

  it('does not render image for URL with spaces (malformed)', async () => {
    renderCard({ decryptedBody: '![x](https://a.com/b c)' });
    await act(async () => {});
    expect(screen.queryByAltText('x')).not.toBeInTheDocument();
  });

  it('does not render image for unclosed bracket syntax', async () => {
    renderCard({ decryptedBody: '![noclose](https://x.com/a.png' });
    await act(async () => {});
    expect(screen.queryByAltText('noclose')).not.toBeInTheDocument();
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
