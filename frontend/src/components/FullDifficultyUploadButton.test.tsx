import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import FullDifficultyUploadButton from './FullDifficultyUploadButton';
import type { DecryptedSection } from './SectionList';

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const mockIsUnlocked = vi.fn(() => true);
const mockGetKey = vi.fn(async () => ({ key: 'mock-key' } as unknown as CryptoKey));
const mockUploadSectionOsu = vi.fn(async () => ({
  id: 'v1',
  section_id: 's1',
  encrypted_content: 'enc:uploaded',
  version: 1,
  is_active: true,
  uploaded_by: 'u1',
  created_at: '',
  updated_at: '',
}));
// Default: 404 (no active base). Explicit type so mockResolvedValue
// overrides can pass partial fixtures without TS inferring Promise<never>.
const mockDownloadBaseOsu = vi.fn<[], Promise<unknown>>(async () => {
  const err = new Error('No base');
  (err as any).isAxiosError = true;
  (err as any).response = { status: 404 };
  throw err;
});

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

vi.mock('../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/endpoints')>();
  return {
    ...actual,
    uploadSectionOsu: (...args: any[]) => mockUploadSectionOsu(...args),
    downloadBaseOsu: (...args: any[]) => mockDownloadBaseOsu(...args),
  };
});

vi.mock('../utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/crypto')>();
  return {
    ...actual,
    encrypt: vi.fn(async (_key: CryptoKey, plaintext: string, _aad: string) => `enc:${plaintext}`),
    decrypt: vi.fn(async (_key: CryptoKey, ciphertext: string, _aad: string) =>
      ciphertext.replace(/^enc:/, ''),
    ),
    sectionOsuVersionAad: vi.fn(
      (versionId: string, mapsetId: string) => `SectionOsuVersion|${versionId}|${mapsetId}`,
    ),
    difficultyBaseOsuVersionAad: vi.fn(
      (versionId: string, mapsetId: string) => `DifficultyBaseOsuVersion|${versionId}|${mapsetId}`,
    ),
  };
});

vi.mock('../utils/osuParser', () => ({
  validateOsuFile: vi.fn((content: string) => {
    if (content === 'invalid') return 'Missing [HitObjects] section';
    return null;
  }),
  parseOsuFile: vi.fn((content: string) => ({ content })),
  parseBookmarks: vi.fn(() => []),
  // Passthrough: the candidate base content is unchanged by a bookmark rewrite
  // in these tests (bookmark preservation is exercised in osuParser's own unit
  // tests); this keeps the promoted base content equal to 'candidate-base'.
  withBookmarks: vi.fn((parsed: { content: string }) => parsed.content),
  buildCandidateBase: vi.fn(() => 'candidate-base'),
  sliceForSection: vi.fn((_parsed: unknown, startMs: number, _endMs: number) => `slice-${startMs}`),
  MAX_OSU_BYTES: 1 * 1024 * 1024,
}));

vi.mock('../utils/osuBase', () => ({
  diffBase: vi.fn(() => ({ critical: [], notice: [], values: {}, hasDiff: false })),
  normalizeFromBase: vi.fn((_content: string, _base: string) => 'normalized'),
}));

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECTIONS: DecryptedSection[] = [
  { id: 's1', name: 'Intro', startTimeMs: 0, endTimeMs: 5000, sortOrder: 0, assignedTo: null },
  { id: 's2', name: 'Verse', startTimeMs: 5000, endTimeMs: 10000, sortOrder: 1, assignedTo: null },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderButton(sections: DecryptedSection[] = SECTIONS) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <FullDifficultyUploadButton
        difficultyId="d1"
        mapsetId="ms1"
        sections={sections}
      />
    </QueryClientProvider>,
  );
}

async function uploadFile(content = 'osu content') {
  const user = userEvent.setup();
  const input = screen.getByLabelText(/Upload full difficulty/i);
  const file = new File([content], 'full.osu', { type: 'text/plain' });
  await user.upload(input, file);
  return user;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FullDifficultyUploadButton', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({ key: 'mock-key' } as unknown as CryptoKey);
    mockDownloadBaseOsu.mockRejectedValue((() => {
      const err = new Error('No base');
      (err as any).isAxiosError = true;
      (err as any).response = { status: 404 };
      return err;
    })());
    const { diffBase, normalizeFromBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({ critical: [], notice: [], values: {}, hasDiff: false });
    vi.mocked(normalizeFromBase).mockImplementation((_content: string) => 'normalized');
  });

  it('renders the button', () => {
    renderButton();
    expect(screen.getByRole('button', { name: /Upload Full Difficulty/i })).toBeInTheDocument();
  });

  it('button is disabled and titled when sections array is empty', () => {
    renderButton([]);
    const btn = screen.getByRole('button', { name: /Upload Full Difficulty/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title');
  });

  it('shows locked error when mapset is locked', async () => {
    mockIsUnlocked.mockReturnValue(false);
    renderButton();
    await uploadFile();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/locked/i);
    });
  });

  it('shows error when sections array is empty at upload time', async () => {
    // Validate the "no sections" guard even if the button is somehow enabled.
    renderButton([]);
    // Force-trigger the file input directly (the button is disabled, so we
    // bypass the click and fire change on the hidden input directly).
    const input = screen.getByLabelText(/Upload full difficulty/i);
    Object.defineProperty(input, 'files', {
      value: [new File(['osu content'], 'full.osu', { type: 'text/plain' })],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/No sections defined/i);
    });
  });

  it('shows validation error for invalid file', async () => {
    renderButton();
    await uploadFile('invalid');
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Missing \[HitObjects\]/i);
    });
    expect(mockUploadSectionOsu).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // First upload — no active base (seeding)
  // -------------------------------------------------------------------------

  it('first upload: uploads all sections, base_version only on first call', async () => {
    // Default: downloadBaseOsu throws 404 — no base yet.
    renderButton();
    await uploadFile();
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(2);
    });

    const firstPayload = mockUploadSectionOsu.mock.calls[0][2];
    const secondPayload = mockUploadSectionOsu.mock.calls[1][2];
    expect(firstPayload.base_version).toBeDefined();
    expect(secondPayload.base_version).toBeUndefined();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('first upload: slices are built from each section range in sort order', async () => {
    const { sliceForSection } = await import('../utils/osuParser');
    renderButton();
    await uploadFile();
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(2);
    });

    expect(vi.mocked(sliceForSection)).toHaveBeenCalledTimes(2);
    // First call is for section with startTimeMs=0, second for startTimeMs=5000.
    expect(vi.mocked(sliceForSection).mock.calls[0][1]).toBe(0);
    expect(vi.mocked(sliceForSection).mock.calls[1][1]).toBe(5000);
  });

  it('first upload: shows success status after all sections done', async () => {
    renderButton();
    await uploadFile();
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/All sections uploaded/i);
    });
  });

  // -------------------------------------------------------------------------
  // Bookmark preservation — a full-diff upload must not adopt the uploaded
  // file's bookmarks (only Import Bookmarks / re-section set them).
  // -------------------------------------------------------------------------

  it('first upload (seed): writes the current section divisions into the base', async () => {
    const { withBookmarks } = await import('../utils/osuParser');
    renderButton();
    await uploadFile();
    await waitFor(() => expect(mockUploadSectionOsu).toHaveBeenCalledTimes(2));
    // No base yet → seed bookmarks from the section divisions: the single
    // interior boundary at 5000 (sections end at 5000 and 10000).
    expect(vi.mocked(withBookmarks)).toHaveBeenCalledWith(expect.anything(), [5000]);
  });

  it('promote: keeps the existing base bookmarks, not the uploaded file bookmarks', async () => {
    const { diffBase } = await import('../utils/osuBase');
    const { parseBookmarks, withBookmarks } = await import('../utils/osuParser');
    // The active base currently carries these (its section divisions).
    vi.mocked(parseBookmarks).mockReturnValueOnce([3333]);
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: [],
      values: { 'Difficulty:HPDrainRate': { candidate: '9', active: '4' } },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });

    renderButton();
    const user = await uploadFile();
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Promote to base/i }));
    await waitFor(() => expect(mockUploadSectionOsu).toHaveBeenCalledTimes(2));

    // The promoted base preserves the base's existing bookmarks (3333).
    expect(vi.mocked(withBookmarks)).toHaveBeenCalledWith(expect.anything(), [3333]);
  });

  // -------------------------------------------------------------------------
  // Clean diff — no modal, no new base
  // -------------------------------------------------------------------------

  it('clean diff: uploads all sections without modal and without new base', async () => {
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });
    // diffBase default returns clean (all empty).
    renderButton();
    await uploadFile();
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(2);
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const firstPayload = mockUploadSectionOsu.mock.calls[0][2];
    expect(firstPayload.base_version).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Critical diff — owner-critical modal
  // -------------------------------------------------------------------------

  it('critical diff: shows owner-critical modal', async () => {
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: [],
      values: { 'Difficulty:HPDrainRate': { candidate: '9', active: '4' } },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });

    renderButton();
    await uploadFile();
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    expect(screen.getByText(/CRITICAL: Are you sure/i)).toBeInTheDocument();
    expect(screen.getByText(/Critical Changes/i)).toBeInTheDocument();
    expect(mockUploadSectionOsu).not.toHaveBeenCalled();
  });

  it('critical diff: Promote uploads all sections with candidate base on first call', async () => {
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: [],
      values: { 'Difficulty:HPDrainRate': { candidate: '9', active: '4' } },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });

    renderButton();
    const user = await uploadFile();
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Promote to base/i }));
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(2);
    });

    const firstPayload = mockUploadSectionOsu.mock.calls[0][2];
    const secondPayload = mockUploadSectionOsu.mock.calls[1][2];
    expect(firstPayload.base_version).toBeDefined();
    expect(secondPayload.base_version).toBeUndefined();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('critical diff: Discard normalizes all slices against base, no new base', async () => {
    const { diffBase, normalizeFromBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: [],
      values: { 'Difficulty:HPDrainRate': { candidate: '9', active: '4' } },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });

    renderButton();
    const user = await uploadFile();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Discard my changes/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Discard my changes/i }));
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(2);
    });

    // normalizeFromBase called once per section, both scopes.
    expect(vi.mocked(normalizeFromBase)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(normalizeFromBase)).toHaveBeenCalledWith(
      expect.any(String),
      'base',
      { critical: true, notice: true },
    );
    const firstPayload = mockUploadSectionOsu.mock.calls[0][2];
    expect(firstPayload.base_version).toBeUndefined();
  });

  it('critical diff: Cancel closes modal without uploading', async () => {
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: [],
      values: { 'Difficulty:HPDrainRate': { candidate: '9', active: '4' } },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });

    renderButton();
    const user = await uploadFile();
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(mockUploadSectionOsu).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Notice diff — owner-notice modal
  // -------------------------------------------------------------------------

  it('notice diff: shows owner-notice modal with Promote + Discard', async () => {
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: [],
      notice: ['General:PreviewTime'],
      values: { 'General:PreviewTime': { candidate: '8000', active: '-1' } },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });

    renderButton();
    await uploadFile();
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    expect(screen.getByText(/Notice changes detected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Promote to base/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Discard my changes/i })).toBeInTheDocument();
    expect(mockUploadSectionOsu).not.toHaveBeenCalled();
  });

  it('notice diff: Promote uploads all sections with candidate base on first call', async () => {
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: [],
      notice: ['General:PreviewTime'],
      values: { 'General:PreviewTime': { candidate: '8000', active: '-1' } },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });

    renderButton();
    const user = await uploadFile();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Promote to base/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Promote to base/i }));
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(2);
    });

    const firstPayload = mockUploadSectionOsu.mock.calls[0][2];
    const secondPayload = mockUploadSectionOsu.mock.calls[1][2];
    expect(firstPayload.base_version).toBeDefined();
    expect(secondPayload.base_version).toBeUndefined();
  });

  it('notice diff: Cancel closes modal without uploading', async () => {
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: [],
      notice: ['General:PreviewTime'],
      values: { 'General:PreviewTime': { candidate: '8000', active: '-1' } },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });

    renderButton();
    const user = await uploadFile();
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(mockUploadSectionOsu).not.toHaveBeenCalled();
  });

  it('notice diff: Discard normalizes notice scope only, no new base', async () => {
    const { diffBase, normalizeFromBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: [],
      notice: ['General:PreviewTime'],
      values: { 'General:PreviewTime': { candidate: '8000', active: '-1' } },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });

    renderButton();
    const user = await uploadFile();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Discard my changes/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Discard my changes/i }));
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(2);
    });

    expect(vi.mocked(normalizeFromBase)).toHaveBeenCalledWith(
      expect.any(String),
      'base',
      { critical: false, notice: true },
    );
    const firstPayload = mockUploadSectionOsu.mock.calls[0][2];
    expect(firstPayload.base_version).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Upload failure
  // -------------------------------------------------------------------------

  it('upload failure: shows error and does not report success', async () => {
    mockUploadSectionOsu.mockRejectedValueOnce(new Error('Network error'));

    renderButton();
    await uploadFile();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Network error/i);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('partial failure: cache is invalidated even when second section upload throws', async () => {
    // Section 1 succeeds, section 2 throws. The cache for section 1 must
    // still be invalidated — invalidateAll() runs in finally, not try.
    mockUploadSectionOsu
      .mockResolvedValueOnce({
        id: 'v1',
        section_id: 's1',
        encrypted_content: 'enc:ok',
        version: 1,
        is_active: true,
        uploaded_by: 'u1',
        created_at: '',
        updated_at: '',
      })
      .mockRejectedValueOnce(new Error('Section 2 failed'));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { render: localRender } = await import('@testing-library/react');
    const { QueryClientProvider: QCP } = await import('@tanstack/react-query');
    localRender(
      <QCP client={queryClient}>
        <FullDifficultyUploadButton difficultyId="d1" mapsetId="ms1" sections={SECTIONS} />
      </QCP>,
    );

    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload full difficulty/i);
    await user.upload(input, new File(['osu content'], 'full.osu', { type: 'text/plain' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Section 2 failed/i);
    });

    // invalidateQueries must have been called despite the partial failure.
    expect(invalidateSpy).toHaveBeenCalled();
  });
});
