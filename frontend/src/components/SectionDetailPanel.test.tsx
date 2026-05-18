import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SectionDetailPanel from './SectionDetailPanel';
import type { DecryptedSection } from './SectionList';
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
};

const POSTS: DecryptedPost[] = [
  {
    id: 'p1',
    difficulty_id: 'd1',
    author_id: 'current-user-uuid',
    parent_id: null,
    tag: 'suggestion',
    encrypted_body: 'enc:00:15:000 - too close',
    created_at: '2024-01-01T12:00:00Z',
    updated_at: '2024-01-01T12:00:00Z',
    decryptedBody: '00:15:000 - too close',
    extractedMs: 15000,
  },
  {
    id: 'p2',
    difficulty_id: 'd1',
    author_id: 'other-user-uuid',
    parent_id: null,
    tag: 'problem',
    encrypted_body: 'enc:00:45:000 - offbeat',
    created_at: '2024-01-01T13:00:00Z',
    updated_at: '2024-01-01T13:00:00Z',
    decryptedBody: '00:45:000 - offbeat',
    extractedMs: 45000,
  },
  {
    id: 'p3',
    difficulty_id: 'd1',
    author_id: 'other-user-uuid',
    parent_id: null,
    tag: 'general',
    encrypted_body: 'enc:No timestamp',
    created_at: '2024-01-01T14:00:00Z',
    updated_at: '2024-01-01T14:00:00Z',
    decryptedBody: 'No timestamp',
    extractedMs: null,
  },
];

function renderPanel(props?: Partial<React.ComponentProps<typeof SectionDetailPanel>>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SectionDetailPanel
        section={SECTION}
        posts={POSTS}
        mapsetId="ms1"
        difficultyId="d1"
        currentUserId="current-user-uuid"
        isOwner={false}
        canEditStructure={false}
        onCreatePost={vi.fn()}
        onUpdatePost={vi.fn()}
        onDeletePost={vi.fn()}
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
  });

  it('renders section name and time range', () => {
    renderPanel();
    expect(screen.getByText('Intro')).toBeInTheDocument();
    expect(screen.getByText(/00:00\.000 – 00:30\.000/i)).toBeInTheDocument();
  });

  it('shows post count in header', () => {
    renderPanel();
    expect(screen.getByText(/Posts \(1\)/i)).toBeInTheDocument();
  });

  it('filters posts to only those within section time range', () => {
    renderPanel();
    // p1 (15000ms) is inside [0, 30000]
    expect(screen.getByText(/too close/i)).toBeInTheDocument();
    // p2 (45000ms) is outside
    expect(screen.queryByText(/offbeat/i)).not.toBeInTheDocument();
    // p3 has no timestamp so it's not shown
    expect(screen.queryByText(/No timestamp/i)).not.toBeInTheDocument();
  });

  it('shows no-posts message when section has no posts', () => {
    renderPanel({ posts: [] });
    expect(screen.getByText(/No posts for this section yet/i)).toBeInTheDocument();
  });

  it('shows New Post button', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /New Post/i })).toBeInTheDocument();
  });

  it('toggles create post form', async () => {
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /New Post/i }));
    expect(screen.getByLabelText(/New post/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Hide Form/i }));
    expect(screen.queryByLabelText(/New post/i)).not.toBeInTheDocument();
  });

  it('shows upload and edit buttons when canEditStructure is true', () => {
    renderPanel({ canEditStructure: true, role: 'owner' });
    expect(screen.getByText('Upload .osu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit/i })).toBeInTheDocument();
  });

  it('hides upload and edit buttons when canEditStructure is false', () => {
    renderPanel({ canEditStructure: false });
    expect(screen.queryByText('Upload .osu')).not.toBeInTheDocument();
    // Section-level Edit button is hidden; PostCard-level Edit buttons may still appear
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
    // The section-level Edit button is in the panel header; PostCards also have Edit buttons.
    // Use getAllBy and click the first one (section header renders before posts).
    const editButtons = screen.getAllByRole('button', { name: /Edit/i });
    await user.click(editButtons[0]);
    expect(onEditSection).toHaveBeenCalledTimes(1);
    expect(onEditSection).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('calls onCreatePost when submitting a new post', async () => {
    const onCreatePost = vi.fn();
    renderPanel({ onCreatePost });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /New Post/i }));

    const textarea = screen.getByLabelText(/New post/i);
    await user.type(textarea, '01:00:000 - great rhythm');

    await user.click(screen.getByRole('button', { name: /^Post$/i }));

    await waitFor(() => {
      expect(onCreatePost).toHaveBeenCalledTimes(1);
    });

    const payload = onCreatePost.mock.calls[0][0];
    expect(payload.tag).toBe('general');
    expect(payload.encrypted_body).toBe('enc:01:00:000 - great rhythm');
  });

  it('calls onDeletePost when Delete is clicked', async () => {
    const onDeletePost = vi.fn();
    window.confirm = vi.fn(() => true);
    renderPanel({ isOwner: true, onDeletePost });
    const user = userEvent.setup();
    const deleteButtons = screen.getAllByRole('button', { name: /Delete/i });
    await user.click(deleteButtons[0]);

    await waitFor(() => {
      expect(onDeletePost).toHaveBeenCalledTimes(1);
    });
  });
});
