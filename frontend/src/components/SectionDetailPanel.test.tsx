import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SectionDetailPanel from './SectionDetailPanel';
import type { DecryptedSection } from './SectionList';
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

vi.mock('./OsuVersionHistory', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="version-history-panel">
      <button onClick={onClose}>Close history</button>
    </div>
  ),
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

function renderPanel(props?: Partial<React.ComponentProps<typeof SectionDetailPanel>>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SectionDetailPanel
        section={SECTION}
        mapsetId="ms1"
        mapsetTitle="Test Mapset"
        difficultyId="d1"
        currentUserId="current-user-uuid"
        isOwner={false}
        canEditStructure={false}
        {...props}
      />
    </QueryClientProvider>,
  );
}

async function openManageMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Manage Section/i }));
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

  it('does not render any posts (posts live in the PostsPanel below)', () => {
    renderPanel();
    expect(screen.queryByTestId('post-card')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New Post/i })).not.toBeInTheDocument();
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

  it('shows a placeholder (keeping panel height stable) when no versions exist', () => {
    mockSectionVersions.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPanel();
    // The line is always rendered to avoid layout flicker once the on-demand
    // latest version loads; with no version it falls back to placeholder copy.
    expect(screen.getByText(/No uploads yet/i)).toBeInTheDocument();
  });

  it('shows a placeholder while the latest version is still loading', () => {
    mockSectionVersions.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderPanel();
    expect(screen.getByText(/No uploads yet/i)).toBeInTheDocument();
  });

  it('shows upload button and edit action in manage menu when canEditStructure is true', async () => {
    const user = userEvent.setup();
    renderPanel({ canEditStructure: true, role: 'owner', onEditSection: vi.fn() });
    expect(screen.getByRole('button', { name: /Upload \.osu/i })).toBeInTheDocument();
    await openManageMenu(user);
    expect(screen.getByRole('menuitem', { name: /Edit section/i })).toBeInTheDocument();
  });

  it('hides upload button and edit action when canEditStructure is false', async () => {
    const user = userEvent.setup();
    renderPanel({ canEditStructure: false });
    expect(screen.queryByRole('button', { name: /Upload \.osu/i })).not.toBeInTheDocument();
    await openManageMenu(user);
    expect(screen.queryByRole('menuitem', { name: /Edit/i })).not.toBeInTheDocument();
  });

  it('shows download button and version history in manage menu', async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(screen.getByRole('button', { name: /Download \.osu/i })).toBeInTheDocument();
    await openManageMenu(user);
    expect(screen.getByRole('menuitem', { name: /Version history/i })).toBeInTheDocument();
  });

  it('renders action buttons in order: download, upload, manage; menu items: history, edit, split, merge, delete', async () => {
    const user = userEvent.setup();
    renderPanel({
      isOwner: true,
      canEditStructure: true,
      role: 'owner',
      onEditSection: vi.fn(),
      onSplitSection: vi.fn(),
      onMergeSection: vi.fn(),
      onDeleteSection: vi.fn(),
      nextSection: { ...SECTION, id: 's2', name: 'Verse' },
    });

    const directOrder = ['Upload .osu', 'Download .osu', 'Manage Section'];
    const directLabels = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '')
      .filter((label) => directOrder.includes(label));
    expect(directLabels).toEqual(directOrder);

    await openManageMenu(user);

    const menuOrder = ['Version history', 'Edit section', 'Split', 'Merge with next', 'Delete'];
    const menuLabels = screen
      .getAllByRole('menuitem')
      .map((item) => item.textContent?.trim() ?? '');
    expect(menuLabels).toEqual(menuOrder);
  });

  it('always labels Edit as "Edit section" in the manage menu', async () => {
    const user = userEvent.setup();
    renderPanel({ canEditStructure: true, role: 'mapper', onEditSection: vi.fn() });
    await openManageMenu(user);
    expect(screen.getByRole('menuitem', { name: 'Edit section' })).toBeInTheDocument();
  });

  it('calls onEditSection when Edit section is clicked in the manage menu', async () => {
    const onEditSection = vi.fn();
    renderPanel({ canEditStructure: true, onEditSection });
    const user = userEvent.setup();
    await openManageMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Edit section/i }));
    expect(onEditSection).toHaveBeenCalledTimes(1);
    expect(onEditSection).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  describe('Delete section', () => {
    it('is visible to the mapset owner in the manage menu', async () => {
      const user = userEvent.setup();
      renderPanel({ isOwner: true, onDeleteSection: vi.fn() });
      await openManageMenu(user);
      expect(screen.getByRole('menuitem', { name: /Delete/i })).toBeInTheDocument();
    });

    it('is hidden for mappers (canEditStructure without isOwner)', async () => {
      const user = userEvent.setup();
      renderPanel({
        isOwner: false,
        canEditStructure: true,
        role: 'mapper',
        onEditSection: vi.fn(),
        onDeleteSection: vi.fn(),
      });
      await openManageMenu(user);
      // Edit is visible to mappers; Delete is not.
      expect(screen.getByRole('menuitem', { name: /Edit/i })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: /Delete/i })).not.toBeInTheDocument();
    });

    it('does nothing when the user cancels the confirm dialog', async () => {
      const onDeleteSection = vi.fn();
      window.confirm = vi.fn(() => false);
      renderPanel({ isOwner: true, onDeleteSection });
      const user = userEvent.setup();
      await openManageMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /Delete/i }));
      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(onDeleteSection).not.toHaveBeenCalled();
    });

    it('calls onDeleteSection with the section when confirmed', async () => {
      const onDeleteSection = vi.fn();
      window.confirm = vi.fn(() => true);
      renderPanel({ isOwner: true, onDeleteSection });
      const user = userEvent.setup();
      await openManageMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /Delete/i }));
      await waitFor(() => {
        expect(onDeleteSection).toHaveBeenCalledTimes(1);
      });
      expect(onDeleteSection).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    });
  });

  it('calls onSplitSection with the section when Split is clicked in the manage menu', async () => {
    const onSplitSection = vi.fn();
    renderPanel({ isOwner: true, onSplitSection });
    const user = userEvent.setup();
    await openManageMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Split/i }));
    expect(onSplitSection).toHaveBeenCalledTimes(1);
    expect(onSplitSection).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  describe('Merge section', () => {
    const NEXT_SECTION: DecryptedSection = {
      id: 's2',
      name: 'Verse',
      startTimeMs: 30000,
      endTimeMs: 60000,
      sortOrder: 1,
      assignedTo: null,
    };

    it('is hidden when there is no next section to merge with', async () => {
      const user = userEvent.setup();
      renderPanel({ isOwner: true, onMergeSection: vi.fn(), nextSection: null });
      await openManageMenu(user);
      expect(screen.queryByRole('menuitem', { name: /Merge/i })).not.toBeInTheDocument();
    });

    it('is visible when a next section exists', async () => {
      const user = userEvent.setup();
      renderPanel({ isOwner: true, onMergeSection: vi.fn(), nextSection: NEXT_SECTION });
      await openManageMenu(user);
      expect(screen.getByRole('menuitem', { name: /Merge/i })).toBeInTheDocument();
    });

    it('does nothing when the user cancels the confirm dialog', async () => {
      const onMergeSection = vi.fn();
      window.confirm = vi.fn(() => false);
      renderPanel({ isOwner: true, onMergeSection, nextSection: NEXT_SECTION });
      const user = userEvent.setup();
      await openManageMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /Merge/i }));
      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(onMergeSection).not.toHaveBeenCalled();
    });

    it('calls onMergeSection with the section when confirmed', async () => {
      const onMergeSection = vi.fn();
      window.confirm = vi.fn(() => true);
      renderPanel({ isOwner: true, onMergeSection, nextSection: NEXT_SECTION });
      const user = userEvent.setup();
      await openManageMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /Merge/i }));
      await waitFor(() => {
        expect(onMergeSection).toHaveBeenCalledTimes(1);
      });
      expect(onMergeSection).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    });
  });

  describe('Manage menu open/close behavior', () => {
    it('menu is hidden until the trigger is clicked', async () => {
      const user = userEvent.setup();
      renderPanel();
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      await openManageMenu(user);
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('toggles the menu closed when the trigger is clicked again', async () => {
      const user = userEvent.setup();
      renderPanel();
      await openManageMenu(user);
      expect(screen.getByRole('menu')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Manage Section/i }));
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('closes on Escape and returns focus to the trigger', async () => {
      const user = userEvent.setup();
      renderPanel();
      const trigger = screen.getByRole('button', { name: /Manage Section/i });
      await openManageMenu(user);
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    it('closes on Tab without returning focus to the trigger', async () => {
      const user = userEvent.setup();
      renderPanel();
      const trigger = screen.getByRole('button', { name: /Manage Section/i });
      await openManageMenu(user);
      await user.keyboard('{Tab}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      // Tab should NOT send focus back to the trigger (unlike Escape).
      expect(trigger).not.toHaveFocus();
    });

    it('menu items have tabIndex=-1 so they are excluded from the natural tab order', async () => {
      const user = userEvent.setup();
      renderPanel({
        isOwner: true,
        canEditStructure: true,
        role: 'owner',
        onEditSection: vi.fn(),
        onSplitSection: vi.fn(),
        onMergeSection: vi.fn(),
        onDeleteSection: vi.fn(),
        nextSection: { ...SECTION, id: 's2', name: 'Verse' },
      });
      await openManageMenu(user);
      for (const item of screen.getAllByRole('menuitem')) {
        expect(item).toHaveAttribute('tabindex', '-1');
      }
    });

    it('closes when clicking outside the menu container', async () => {
      const user = userEvent.setup();
      renderPanel();
      await openManageMenu(user);
      expect(screen.getByRole('menu')).toBeInTheDocument();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('moves focus to the first item when the menu opens', async () => {
      const user = userEvent.setup();
      renderPanel();
      await openManageMenu(user);
      expect(screen.getByRole('menuitem', { name: /Version history/i })).toHaveFocus();
    });

    it('cycles focus through items with ArrowDown/ArrowUp and wraps at the ends', async () => {
      const user = userEvent.setup();
      renderPanel({
        isOwner: true,
        canEditStructure: true,
        role: 'owner',
        onEditSection: vi.fn(),
        onSplitSection: vi.fn(),
        onMergeSection: vi.fn(),
        onDeleteSection: vi.fn(),
        nextSection: { ...SECTION, id: 's2', name: 'Verse' },
      });
      await openManageMenu(user);

      expect(screen.getByRole('menuitem', { name: /Version history/i })).toHaveFocus();

      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: 'Edit section' })).toHaveFocus();

      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: 'Split' })).toHaveFocus();

      // Jump to last with End, then wrap past it with ArrowDown
      await user.keyboard('{End}');
      expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();

      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: /Version history/i })).toHaveFocus();

      // ArrowUp wraps from first to last
      await user.keyboard('{ArrowUp}');
      expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();

      // Home jumps to first
      await user.keyboard('{Home}');
      expect(screen.getByRole('menuitem', { name: /Version history/i })).toHaveFocus();
    });

    it('Version history closes the menu and opens the history panel', async () => {
      const user = userEvent.setup();
      renderPanel();
      await openManageMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /Version history/i }));
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(screen.getByTestId('version-history-panel')).toBeInTheDocument();
    });

    it('Edit section closes the menu', async () => {
      const user = userEvent.setup();
      renderPanel({ canEditStructure: true, onEditSection: vi.fn() });
      await openManageMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /Edit section/i }));
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('Split closes the menu', async () => {
      const user = userEvent.setup();
      renderPanel({ isOwner: true, onSplitSection: vi.fn() });
      await openManageMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /Split/i }));
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('Delete confirmed closes the menu; Delete cancelled keeps it open', async () => {
      const user = userEvent.setup();
      renderPanel({ isOwner: true, onDeleteSection: vi.fn() });

      window.confirm = vi.fn(() => false);
      await openManageMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /Delete/i }));
      expect(screen.getByRole('menu')).toBeInTheDocument();

      window.confirm = vi.fn(() => true);
      await user.click(screen.getByRole('menuitem', { name: /Delete/i }));
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('Merge confirmed closes the menu; Merge cancelled keeps it open', async () => {
      const NEXT_SECTION: DecryptedSection = {
        id: 's2', name: 'Verse', startTimeMs: 30000, endTimeMs: 60000, sortOrder: 1, assignedTo: null,
      };
      const user = userEvent.setup();
      renderPanel({ isOwner: true, onMergeSection: vi.fn(), nextSection: NEXT_SECTION });

      window.confirm = vi.fn(() => false);
      await openManageMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /Merge/i }));
      expect(screen.getByRole('menu')).toBeInTheDocument();

      window.confirm = vi.fn(() => true);
      await user.click(screen.getByRole('menuitem', { name: /Merge/i }));
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });
});
