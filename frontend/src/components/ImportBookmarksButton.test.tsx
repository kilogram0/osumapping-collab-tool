import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ImportBookmarksButton from './ImportBookmarksButton';
import type { DecryptedSection } from './SectionList';

const mockGetKey = vi.fn(async () => ({} as CryptoKey));
vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({ getKey: mockGetKey }),
}));

const mockResection = vi.fn();
const mockImport = vi.fn();
vi.mock('../utils/resectionFromBookmarks', () => ({
  resectionFromBookmarks: (...args: unknown[]) => mockResection(...args),
}));
vi.mock('../utils/importSectionsFromBookmarks', () => ({
  importSectionsFromBookmarks: (...args: unknown[]) => mockImport(...args),
}));

const mockFetchBaseVersions = vi.fn();
vi.mock('../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/endpoints')>();
  return { ...actual, fetchBaseOsuVersions: (...args: unknown[]) => mockFetchBaseVersions(...args) };
});

function sec(id: string, sortOrder: number): DecryptedSection {
  return { id, name: `S${sortOrder + 1}`, startTimeMs: sortOrder * 1000, endTimeMs: (sortOrder + 1) * 1000, sortOrder, assignedTo: null };
}

function setup(existingSections: DecryptedSection[]) {
  const onSuccess = vi.fn();
  const onResection = vi.fn();
  const onError = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ImportBookmarksButton
        difficultyId="d1"
        mapsetId="ms1"
        existingSections={existingSections}
        songLengthMs={4000}
        onSuccess={onSuccess}
        onResection={onResection}
        onError={onError}
      />
    </QueryClientProvider>,
  );
  return { onSuccess, onResection, onError };
}

async function uploadFile() {
  const user = userEvent.setup();
  const input = screen.getByLabelText(/Import sections from \.osu bookmarks/i);
  const file = new File(
    ['osu file format v14\n\n[Editor]\nBookmarks: 2000\n\n[HitObjects]\n256,192,500,1,0\n'],
    'test.osu',
    { type: 'text/plain' },
  );
  await user.upload(input, file);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchBaseVersions.mockResolvedValue([]);
  mockResection.mockResolvedValue({ created: 2, total: 2, deleted: 1, error: null });
  mockImport.mockResolvedValue({ created: 2, total: 2, error: null });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('ImportBookmarksButton', () => {
  it('re-sections (with confirmation) when the difficulty already has sections', async () => {
    const { onResection } = setup([sec('old-a', 0)]);
    await uploadFile();

    await waitFor(() => expect(mockResection).toHaveBeenCalledTimes(1));
    expect(window.confirm).toHaveBeenCalled();
    // The append/prepopulate path must NOT run for a populated difficulty.
    expect(mockImport).not.toHaveBeenCalled();
    expect(onResection).toHaveBeenCalledWith(2);
  });

  it('does nothing when the re-section confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    setup([sec('old-a', 0)]);
    await uploadFile();

    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(mockResection).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('uses the append/prepopulate path (no confirm) on a difficulty with no sections', async () => {
    const { onSuccess } = setup([]);
    await uploadFile();

    await waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(mockResection).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledWith(2, true);
  });
});
