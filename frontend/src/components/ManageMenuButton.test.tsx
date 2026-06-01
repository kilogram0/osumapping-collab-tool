import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import ManageMenuButton from './ManageMenuButton';

type Props = React.ComponentProps<typeof ManageMenuButton>;

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    onOpenBaseHistory: vi.fn(),
    baseHistoryDisabled: false,
    showMembers: true,
    membersLabel: 'Manage Members',
    onOpenMembers: vi.fn(),
    ...overrides,
  };
  render(<ManageMenuButton {...props} />);
  return props;
}

describe('ManageMenuButton', () => {
  it('hides the menu until the Manage trigger is clicked', async () => {
    const user = userEvent.setup();
    setup();

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Manage$/i }));

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Base History' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Manage Members' })).toBeInTheDocument();
  });

  it('opens base history and closes the menu', async () => {
    const user = userEvent.setup();
    const { onOpenBaseHistory } = setup();

    await user.click(screen.getByRole('button', { name: /^Manage$/i }));
    await user.click(screen.getByRole('menuitem', { name: 'Base History' }));

    expect(onOpenBaseHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens the members modal via the members option', async () => {
    const user = userEvent.setup();
    const { onOpenMembers } = setup({ membersLabel: 'View Members' });

    await user.click(screen.getByRole('button', { name: /^Manage$/i }));
    await user.click(screen.getByRole('menuitem', { name: 'View Members' }));

    expect(onOpenMembers).toHaveBeenCalledTimes(1);
  });

  it('hides the members option when showMembers is false', async () => {
    const user = userEvent.setup();
    setup({ showMembers: false });

    await user.click(screen.getByRole('button', { name: /^Manage$/i }));

    expect(screen.getByRole('menuitem', { name: 'Base History' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /members/i })).not.toBeInTheDocument();
  });

  it('moves focus into the menu on open and cycles items with arrow keys', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: /^Manage$/i }));
    // First item is focused on open.
    expect(screen.getByRole('menuitem', { name: 'Base History' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Manage Members' })).toHaveFocus();

    // Wraps back to the top.
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Base History' })).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Manage Members' })).toHaveFocus();
  });

  it('returns focus to the trigger when closed with Escape', async () => {
    const user = userEvent.setup();
    setup();

    const trigger = screen.getByRole('button', { name: /^Manage$/i });
    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps a disabled item focusable for arrow navigation', async () => {
    const user = userEvent.setup();
    setup({ baseHistoryDisabled: true });

    await user.click(screen.getByRole('button', { name: /^Manage$/i }));
    // Disabled item is still the initial focus target (APG: focusable, not activatable).
    expect(screen.getByRole('menuitem', { name: 'Base History' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Manage Members' })).toHaveFocus();
  });

  it('disables base history when no difficulty is selected', async () => {
    const user = userEvent.setup();
    const { onOpenBaseHistory } = setup({ baseHistoryDisabled: true });

    await user.click(screen.getByRole('button', { name: /^Manage$/i }));
    const item = screen.getByRole('menuitem', { name: 'Base History' });
    // aria-disabled (not native `disabled`) so the item stays focusable/announced.
    expect(item).toHaveAttribute('aria-disabled', 'true');

    await user.click(item);
    expect(onOpenBaseHistory).not.toHaveBeenCalled();
  });
});
