import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CreatePostForm from './CreatePostForm';
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
    encrypt: vi.fn(async (_key: CryptoKey, plaintext: string, _aad: string) => `enc:${plaintext}`),
    postFieldAad: vi.fn((postId: string, mapsetId: string) => `Post|${postId}|${mapsetId}`),
  };
});

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

const PARENT_POST: Post = {
  id: 'parent-1',
  difficulty_id: 'd1',
  author_id: 'author-1',
  parent_id: null,
  tag: 'general',
  encrypted_body: 'enc:parent body',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

describe('CreatePostForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({ key: 'mock-key' } as unknown as CryptoKey);
  });

  it('renders tag selector and textarea', () => {
    render(<CreatePostForm mapsetId="ms1" difficultyId="d1" onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/Tag/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/New post/i)).toBeInTheDocument();
  });

  it('submits encrypted post on form submission', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CreatePostForm mapsetId="ms1" difficultyId="d1" onSubmit={onSubmit} />);

    const user = userEvent.setup();
    const textarea = screen.getByLabelText(/New post/i);
    await user.type(textarea, '00:46:140 - these are too close');

    await user.click(screen.getByRole('button', { name: /Post/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const payload = onSubmit.mock.calls[0][0];
    expect(payload.tag).toBe('general');
    expect(payload.encrypted_body).toBe('enc:00:46:140 - these are too close');
    expect(payload.parent_id).toBeNull();
  });

  it('shows error when body is empty', async () => {
    render(<CreatePostForm mapsetId="ms1" difficultyId="d1" onSubmit={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Post/i }));
    expect(screen.getByText(/Post body cannot be empty/i)).toBeInTheDocument();
  });

  it('shows error when mapset is locked', async () => {
    mockIsUnlocked.mockReturnValue(false);
    render(<CreatePostForm mapsetId="ms1" difficultyId="d1" onSubmit={vi.fn()} />);
    const user = userEvent.setup();
    const textarea = screen.getByLabelText(/New post/i);
    await user.type(textarea, 'some text');
    await user.click(screen.getByRole('button', { name: /Post/i }));
    expect(screen.getByText(/Mapset is locked/i)).toBeInTheDocument();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    render(<CreatePostForm mapsetId="ms1" difficultyId="d1" onSubmit={vi.fn()} onCancel={onCancel} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('includes parent_id when in reply mode', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CreatePostForm
        mapsetId="ms1"
        difficultyId="d1"
        onSubmit={onSubmit}
        parentPost={PARENT_POST}
      />,
    );

    const user = userEvent.setup();
    const textarea = screen.getByLabelText(/Reply/i);
    await user.type(textarea, 'reply body');

    await user.click(screen.getByRole('button', { name: /Reply/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const payload = onSubmit.mock.calls[0][0];
    expect(payload.parent_id).toBe('parent-1');
    expect(payload.encrypted_body).toBe('enc:reply body');
  });

  it('pre-fills body and tag in edit mode', async () => {
    const editingPost: Post = {
      ...PARENT_POST,
      id: 'edit-1',
      tag: 'problem',
      parent_id: null,
    };
    render(
      <CreatePostForm
        mapsetId="ms1"
        difficultyId="d1"
        onSubmit={vi.fn()}
        editingPost={editingPost}
        initialBody="existing body"
      />,
    );

    expect(screen.getByLabelText(/Edit post/i)).toHaveValue('existing body');
    expect(screen.queryByLabelText(/Tag/i)).not.toBeInTheDocument();
  });

  it('hides tag selector in edit mode', async () => {
    const editingPost: Post = {
      ...PARENT_POST,
      id: 'edit-1',
      tag: 'problem',
      parent_id: null,
    };
    render(
      <CreatePostForm
        mapsetId="ms1"
        difficultyId="d1"
        onSubmit={vi.fn()}
        editingPost={editingPost}
        initialBody="existing body"
      />,
    );

    expect(screen.queryByLabelText(/Tag/i)).not.toBeInTheDocument();
  });

  it('submits edit with existing post id', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const editingPost: Post = {
      ...PARENT_POST,
      id: 'edit-1',
      tag: 'problem',
      parent_id: null,
    };
    render(
      <CreatePostForm
        mapsetId="ms1"
        difficultyId="d1"
        onSubmit={onSubmit}
        editingPost={editingPost}
        initialBody="existing body"
      />,
    );

    const user = userEvent.setup();
    const textarea = screen.getByLabelText(/Edit post/i);
    await user.clear(textarea);
    await user.type(textarea, 'updated body');

    await user.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const payload = onSubmit.mock.calls[0][0];
    expect(payload.id).toBe('edit-1');
    expect(payload.encrypted_body).toBe('enc:updated body');
  });

  it('prepends section start timestamp when body has no timestamp and defaultTimestampMs is set', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CreatePostForm
        mapsetId="ms1"
        difficultyId="d1"
        onSubmit={onSubmit}
        defaultTimestampMs={46140}
      />,
    );

    const user = userEvent.setup();
    const textarea = screen.getByLabelText(/New post/i);
    await user.type(textarea, 'Great Part!');

    await user.click(screen.getByRole('button', { name: /Post/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const payload = onSubmit.mock.calls[0][0];
    expect(payload.encrypted_body).toBe('enc:00:46:140 - Great Part!');
  });

  it('does not prepend timestamp when body already contains one', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CreatePostForm
        mapsetId="ms1"
        difficultyId="d1"
        onSubmit={onSubmit}
        defaultTimestampMs={46140}
      />,
    );

    const user = userEvent.setup();
    const textarea = screen.getByLabelText(/New post/i);
    await user.type(textarea, '01:23:456 - different spot');

    await user.click(screen.getByRole('button', { name: /Post/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const payload = onSubmit.mock.calls[0][0];
    expect(payload.encrypted_body).toBe('enc:01:23:456 - different spot');
  });

  it('clears body after successful new post submission', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CreatePostForm mapsetId="ms1" difficultyId="d1" onSubmit={onSubmit} />);

    const user = userEvent.setup();
    const textarea = screen.getByLabelText(/New post/i);
    await user.type(textarea, 'some text');

    await user.click(screen.getByRole('button', { name: /Post/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    expect(textarea).toHaveValue('');
  });

  it('shows Reply & Resolve button when resolveAction is resolve', () => {
    render(
      <CreatePostForm
        mapsetId="ms1"
        difficultyId="d1"
        onSubmit={vi.fn()}
        parentPost={PARENT_POST}
        resolveAction="resolve"
      />,
    );
    expect(screen.getByRole('button', { name: /Reply & Resolve/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reopen/i })).not.toBeInTheDocument();
  });

  it('shows Reopen button when resolveAction is reopen', () => {
    render(
      <CreatePostForm
        mapsetId="ms1"
        difficultyId="d1"
        onSubmit={vi.fn()}
        parentPost={PARENT_POST}
        resolveAction="reopen"
      />,
    );
    expect(screen.getByRole('button', { name: /Reopen/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reply & Resolve/i })).not.toBeInTheDocument();
  });

  it('does not show resolve action button when resolveAction is not set', () => {
    render(
      <CreatePostForm
        mapsetId="ms1"
        difficultyId="d1"
        onSubmit={vi.fn()}
        parentPost={PARENT_POST}
      />,
    );
    expect(screen.queryByRole('button', { name: /Reply & Resolve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reopen/i })).not.toBeInTheDocument();
  });

  it('clicking Reply & Resolve submits with tag resolve', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CreatePostForm
        mapsetId="ms1"
        difficultyId="d1"
        onSubmit={onSubmit}
        parentPost={PARENT_POST}
        resolveAction="resolve"
      />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Reply/i), 'looks good');
    await user.click(screen.getByRole('button', { name: /Reply & Resolve/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].tag).toBe('resolve');
    expect(onSubmit.mock.calls[0][0].parent_id).toBe('parent-1');
  });

  it('clicking Reopen submits with tag reopen', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CreatePostForm
        mapsetId="ms1"
        difficultyId="d1"
        onSubmit={onSubmit}
        parentPost={PARENT_POST}
        resolveAction="reopen"
      />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Reply/i), 'still broken');
    await user.click(screen.getByRole('button', { name: /Reopen/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].tag).toBe('reopen');
  });

  it('Reply button always submits with the regular tag in reply mode', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CreatePostForm
        mapsetId="ms1"
        difficultyId="d1"
        onSubmit={onSubmit}
        parentPost={PARENT_POST}
        resolveAction="resolve"
      />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Reply/i), 'just a comment');
    await user.click(screen.getByRole('button', { name: /^Reply$/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].tag).toBe('general');
  });
});
