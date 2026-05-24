import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import ResolveEvent from './ResolveEvent';
import type { DecryptedPost } from '../types';

const BASE_RESOLVE: DecryptedPost = {
  id: 'rev1',
  difficulty_id: 'd1',
  author_id: 'author-uuid',
  parent_id: 'root-post-id',
  tag: 'resolve',
  encrypted_body: 'enc:Looks good now.',
  created_at: '2024-01-01T12:00:00Z',
  updated_at: '2024-01-01T12:00:00Z',
  decryptedBody: 'Looks good now.',
  extractedMs: null,
};

const BASE_REOPEN: DecryptedPost = {
  ...BASE_RESOLVE,
  id: 'rev2',
  tag: 'reopen',
  decryptedBody: 'Actually the pattern is still off.',
};

function renderEvent(props?: Partial<React.ComponentProps<typeof ResolveEvent>>) {
  return render(
    <ResolveEvent
      post={BASE_RESOLVE}
      currentUserId="other-user"
      isOwner={false}
      {...props}
    />,
  );
}

describe('ResolveEvent', () => {
  it('renders resolve event with checkmark and body', () => {
    renderEvent();
    expect(screen.getByTestId('resolve-event')).toBeInTheDocument();
    expect(screen.getByText(/marked this as resolved/i)).toBeInTheDocument();
    expect(screen.getByText('Looks good now.')).toBeInTheDocument();
  });

  it('renders reopen event with reopen text and body', () => {
    renderEvent({ post: BASE_REOPEN });
    expect(screen.getByText(/reopened this/i)).toBeInTheDocument();
    expect(screen.getByText('Actually the pattern is still off.')).toBeInTheDocument();
  });

  it('uses author username when provided', () => {
    renderEvent({ author: { username: 'mapper42', avatar_url: '' } });
    expect(screen.getByText('mapper42')).toBeInTheDocument();
  });

  it('falls back to user prefix when no author', () => {
    renderEvent({ author: null });
    expect(screen.getByText(/User author-/i)).toBeInTheDocument();
  });

  it('shows delete button for the author', () => {
    const onDelete = vi.fn();
    renderEvent({ currentUserId: 'author-uuid', onDelete });
    expect(screen.getByRole('button', { name: /Delete/i })).toBeInTheDocument();
  });

  it('shows delete button for the owner', () => {
    const onDelete = vi.fn();
    renderEvent({ isOwner: true, onDelete });
    expect(screen.getByRole('button', { name: /Delete/i })).toBeInTheDocument();
  });

  it('hides delete button for non-author non-owner', () => {
    const onDelete = vi.fn();
    renderEvent({ currentUserId: 'someone-else', isOwner: false, onDelete });
    expect(screen.queryByRole('button', { name: /Delete/i })).not.toBeInTheDocument();
  });

  it('calls onDelete with post id when delete is clicked', async () => {
    const onDelete = vi.fn();
    renderEvent({ currentUserId: 'author-uuid', onDelete });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Delete/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('rev1');
  });

  it('resolve event has green styling', () => {
    renderEvent();
    const container = screen.getByTestId('resolve-event');
    expect(container.className).toContain('green');
  });

  it('reopen event has orange styling', () => {
    renderEvent({ post: BASE_REOPEN });
    const container = screen.getByTestId('resolve-event');
    expect(container.className).toContain('orange');
  });
});
