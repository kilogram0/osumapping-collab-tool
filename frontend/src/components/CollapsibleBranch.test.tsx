import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import CollapsibleBranch from './CollapsibleBranch';

const storageStore: Record<string, string> = {};

beforeEach(() => {
  vi.clearAllMocks();
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

function renderBranch(userId: string, postId: string) {
  return render(
    <CollapsibleBranch userId={userId} postId={postId}>
      {(collapsed, toggle) => (
        <div>
          <span data-testid="state">{collapsed ? 'collapsed' : 'open'}</span>
          <button type="button" onClick={toggle}>toggle</button>
        </div>
      )}
    </CollapsibleBranch>,
  );
}

describe('CollapsibleBranch', () => {
  it('starts open by default and toggles on click', async () => {
    renderBranch('u1', 'p1');
    expect(screen.getByTestId('state')).toHaveTextContent('open');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('state')).toHaveTextContent('collapsed');
  });

  it('persists toggled state to localStorage under userId+postId', async () => {
    renderBranch('u1', 'p1');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(localStorage.getItem('post-collapsed:u1:p1')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(localStorage.getItem('post-collapsed:u1:p1')).toBe('false');
  });

  it('restores collapsed state from localStorage on mount', async () => {
    localStorage.setItem('post-collapsed:u1:p1', 'true');
    renderBranch('u1', 'p1');
    await act(async () => {});
    expect(screen.getByTestId('state')).toHaveTextContent('collapsed');
  });

  it('isolates state across different post ids', async () => {
    localStorage.setItem('post-collapsed:u1:p1', 'true');
    renderBranch('u1', 'p2');
    expect(screen.getByTestId('state')).toHaveTextContent('open');
  });
});
