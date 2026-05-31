import { render, screen, waitFor } from '@testing-library/react';
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

  it('does not show latest upload when no versions exist', () => {
    mockSectionVersions.mockReturnValue({ data: [], isLoading: false, error: null });
    renderPanel();
    expect(screen.queryByText(/Latest upload:/i)).not.toBeInTheDocument();
  });

  it('shows upload and edit buttons when canEditStructure is true', () => {
    renderPanel({ canEditStructure: true, role: 'owner', onEditSection: vi.fn() });
    expect(screen.getByText('Upload .osu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit/i })).toBeInTheDocument();
  });

  it('hides upload and edit buttons when canEditStructure is false', () => {
    renderPanel({ canEditStructure: false });
    expect(screen.queryByText('Upload .osu')).not.toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: /Edit/i }));
    expect(onEditSection).toHaveBeenCalledTimes(1);
    expect(onEditSection).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
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
});
