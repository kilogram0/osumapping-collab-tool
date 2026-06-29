import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToastProvider } from '../contexts/ToastContext';
import CopyAssignmentsButton from './CopyAssignmentsButton';
import type { AssignableSection } from '../utils/sectionAssignments';

const membersById = new Map<string, { username: string }>([
  ['u-1', { username: 'alice' }],
  ['u-2', { username: 'bob' }],
]);

function setup(props: Partial<React.ComponentProps<typeof CopyAssignmentsButton>> = {}) {
  const sections: AssignableSection[] = [
    { startTimeMs: 0, endTimeMs: 5000, assignedTo: 'u-1' },
    { startTimeMs: 5000, endTimeMs: 10000, assignedTo: 'u-1' },
    { startTimeMs: 10000, endTimeMs: 15000, assignedTo: 'u-2' },
  ];
  return render(
    <ToastProvider>
      <CopyAssignmentsButton
        sections={sections}
        membersById={membersById}
        {...props}
      />
    </ToastProvider>,
  );
}

describe('CopyAssignmentsButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the dropdown trigger', () => {
    setup();
    expect(screen.getByRole('button', { name: /Copy Assignments/i })).toBeInTheDocument();
  });

  it('opens a menu with For Submission and Raw options when clicked', async () => {
    setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Copy Assignments/i }));
    expect(screen.getByRole('menuitem', { name: /For Submission/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Raw/i })).toBeInTheDocument();
  });

  it('copies the merged "For Submission" text to the clipboard', async () => {
    setup();
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(screen.getByRole('button', { name: /Copy Assignments/i }));
    await user.click(screen.getByRole('menuitem', { name: /For Submission/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(
      '00:00:000 - 00:10:000: alice\n00:10:000 - 00:15:000: bob',
    );
  });

  it('copies the raw per-section text to the clipboard', async () => {
    setup();
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(screen.getByRole('button', { name: /Copy Assignments/i }));
    await user.click(screen.getByRole('menuitem', { name: /Raw/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(
      '00:00:000 - 00:05:000: alice\n00:05:000 - 00:10:000: alice\n00:10:000 - 00:15:000: bob',
    );
  });

  it('is disabled when there are no sections', () => {
    setup({ sections: [], membersById });
    expect(screen.getByRole('button', { name: /Copy Assignments/i })).toBeDisabled();
  });

  it('closes the dropdown when Escape is pressed', async () => {
    setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Copy Assignments/i }));
    expect(screen.getByRole('menuitem', { name: /For Submission/i })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: /For Submission/i })).not.toBeInTheDocument(),
    );
  });
});
