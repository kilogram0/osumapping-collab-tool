import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type React from 'react';
import SectionList from './SectionList';
import type { Section } from '../api/endpoints';
import { decrypt } from '../utils/crypto';

const mockIsUnlocked = vi.fn(() => false);
const mockGetKey = vi.fn(async () => null as CryptoKey | null);
const mockDownloadSectionOsu = vi.fn(async () => ({
  id: 'sov1',
  section_id: 's1',
  encrypted_content: 'enc:osu content',
  version: 1,
  is_active: true,
  uploaded_by: 'u1',
  created_at: '',
  updated_at: '',
}));

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    isUnlocked: mockIsUnlocked,
    getKey: mockGetKey,
    unlockMapset: vi.fn().mockResolvedValue(undefined),
    unlockWithKey: vi.fn().mockResolvedValue(undefined),
    lockMapset: vi.fn().mockResolvedValue(undefined),
    clearAll: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/endpoints')>();
  return {
    ...actual,
    downloadSectionOsu: (...args: any[]) => mockDownloadSectionOsu(...args),
  };
});

vi.mock('../utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/crypto')>();
  return {
    ...actual,
    decrypt: vi.fn(async (_key: CryptoKey, ciphertext: string, _aad: string) => {
      if (ciphertext.startsWith('enc:')) return ciphertext.slice(4);
      return ciphertext;
    }),
    decodeJsonEnvelope: vi.fn((plaintext: string) => {
      try {
        const parsed = JSON.parse(plaintext);
        if (typeof parsed.ms === 'number') return parsed.ms;
        if (typeof parsed.v === 'number') return parsed.v;
      } catch {
        return Number(plaintext);
      }
      return Number(plaintext);
    }),
    sectionFieldAad: vi.fn((sectionId: string, mapsetId: string) => `Section|${sectionId}|${mapsetId}`),
    sectionOsuVersionAad: vi.fn((versionId: string, mapsetId: string) => `SectionOsuVersion|${versionId}|${mapsetId}`),
  };
});

const SECTIONS: Section[] = [
  {
    id: 's2',
    difficulty_id: 'd1',
    encrypted_name: 'enc:Kiai 1',
    encrypted_start_time_ms: 'enc:{"v":0,"ms":30000}',
    encrypted_end_time_ms: 'enc:{"v":0,"ms":60000}',
    encrypted_sort_order: 'enc:{"v":0,"ms":1}',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 's1',
    difficulty_id: 'd1',
    encrypted_name: 'enc:Intro',
    encrypted_start_time_ms: 'enc:{"v":0,"ms":0}',
    encrypted_end_time_ms: 'enc:{"v":0,"ms":30000}',
    encrypted_sort_order: 'enc:{"v":0,"ms":0}',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
];

function renderList(props?: Partial<React.ComponentProps<typeof SectionList>>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SectionList
        sections={SECTIONS}
        mapsetId="ms1"
        difficultyId="d1"
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('SectionList', () => {
  beforeEach(() => {
    mockIsUnlocked.mockReturnValue(false);
    mockGetKey.mockResolvedValue(null);
    vi.mocked(decrypt).mockReset();
    vi.mocked(decrypt).mockImplementation(async (_key: CryptoKey, ciphertext: string, _aad: string) => {
      if (ciphertext.startsWith('enc:')) return ciphertext.slice(4);
      return ciphertext;
    });
    vi.mocked(mockDownloadSectionOsu).mockReset();
    mockDownloadSectionOsu.mockResolvedValue({
      id: 'sov1',
      section_id: 's1',
      encrypted_content: 'enc:osu content',
      version: 1,
      is_active: true,
      uploaded_by: 'u1',
      created_at: '',
      updated_at: '',
    });
  });

  it('renders encrypted placeholders when locked', () => {
    renderList();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(screen.getAllByText(/🔒 Encrypted Section/i)).toHaveLength(2);
  });

  it('renders decrypted names and times when unlocked', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    renderList();
    await act(async () => {});
    expect(screen.getByText('Intro')).toBeInTheDocument();
    expect(screen.getByText('Kiai 1')).toBeInTheDocument();
    expect(screen.getByText(/00:00.000 – 00:30.000/i)).toBeInTheDocument();
    expect(screen.getByText(/00:30.000 – 01:00.000/i)).toBeInTheDocument();
  });

  it('sorts sections by start time', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    renderList();
    await act(async () => {});
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Intro');
    expect(items[1]).toHaveTextContent('Kiai 1');
  });

  it('shows no-sections message when list is empty', () => {
    renderList({ sections: [] });
    expect(screen.getByText(/No sections yet/i)).toBeInTheDocument();
  });

  it('invokes decrypt with the correct per-row AAD', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    renderList();
    await act(async () => {});
    expect(decrypt).toHaveBeenCalledWith(
      expect.anything(),
      'enc:Intro',
      'Section|s1|ms1',
    );
    expect(decrypt).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('ms'),
      'Section|s1|ms1',
    );
  });

  it('falls back to id tiebreaker when start times collide', async () => {
    const colliding: Section[] = [
      {
        id: 's-b',
        difficulty_id: 'd1',
        encrypted_name: 'enc:Second',
        encrypted_start_time_ms: 'enc:{"v":0,"ms":5000}',
        encrypted_end_time_ms: 'enc:{"v":0,"ms":10000}',
        encrypted_sort_order: 'enc:{"v":0,"ms":5}',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
      {
        id: 's-a',
        difficulty_id: 'd1',
        encrypted_name: 'enc:First',
        encrypted_start_time_ms: 'enc:{"v":0,"ms":5000}',
        encrypted_end_time_ms: 'enc:{"v":0,"ms":10000}',
        encrypted_sort_order: 'enc:{"v":0,"ms":5}',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
    ];
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    renderList({ sections: colliding });
    await act(async () => {});
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('First');
    expect(items[1]).toHaveTextContent('Second');
  });

  it('shows failure state when all decrypts fail while unlocked', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    vi.mocked(decrypt).mockRejectedValue(new Error('aad mismatch'));
    renderList();
    await act(async () => {});
    expect(screen.getAllByText(/Failed to decrypt section/i)).toHaveLength(2);
  });

  it('shows upload and download buttons when unlocked', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    renderList();
    await act(async () => {});
    expect(screen.getAllByText('Upload .osu')).toHaveLength(2);
    expect(screen.getAllByText('Download .osu')).toHaveLength(2);
  });

  it('shows edit button when unlocked and onEdit is provided', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    const onEdit = vi.fn();
    renderList({ onEdit });
    await act(async () => {});
    const editButtons = screen.getAllByRole('button', { name: /Edit/i });
    expect(editButtons).toHaveLength(2);
  });

  it('calls onEdit when Edit button is clicked', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);
    const onEdit = vi.fn();
    renderList({ onEdit });
    await act(async () => {});
    const user = userEvent.setup();
    const editButtons = screen.getAllByRole('button', { name: /Edit/i });
    await user.click(editButtons[0]);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', name: 'Intro' }),
    );
  });

  it('hides upload and download buttons when locked', () => {
    renderList();
    expect(screen.queryByText('Upload .osu')).not.toBeInTheDocument();
    expect(screen.queryByText('Download .osu')).not.toBeInTheDocument();
  });

  it('triggers download flow when Download .osu is clicked', async () => {
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({} as CryptoKey);

    const createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    const clickSpy = vi.fn();

    vi.stubGlobal('URL', {
      createObjectURL,
      revokeObjectURL,
    });

    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const el = originalCreateElement(tagName);
      if (tagName === 'a') {
        el.click = clickSpy;
      }
      return el;
    });

    renderList();
    await act(async () => {});

    const user = userEvent.setup();
    const downloadButtons = screen.getAllByRole('button', { name: /Download \.osu/i });
    await user.click(downloadButtons[0]);

    await waitFor(() => {
      expect(mockDownloadSectionOsu).toHaveBeenCalledTimes(1);
    });
    expect(mockDownloadSectionOsu).toHaveBeenCalledWith('d1', 's1');

    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    });
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');

    vi.restoreAllMocks();
  });
});
