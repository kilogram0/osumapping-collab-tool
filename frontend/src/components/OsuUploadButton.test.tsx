import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import OsuUploadButton from './OsuUploadButton';

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
// Default: 404 (no active base). Without an explicit type, TS infers
// Promise<never> from the always-throwing body, which then rejects partial
// fixtures in mockResolvedValue overrides downstream.
const mockDownloadBaseOsu = vi.fn<[], Promise<unknown>>(async () => {
  const err = new Error('No base');
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
    decrypt: vi.fn(async (_key: CryptoKey, ciphertext: string, _aad: string) => ciphertext.replace(/^enc:/, '')),
    sectionOsuVersionAad: vi.fn((versionId: string, mapsetId: string) => `SectionOsuVersion|${versionId}|${mapsetId}`),
    difficultyBaseOsuVersionAad: vi.fn((versionId: string, mapsetId: string) => `DifficultyBaseOsuVersion|${versionId}|${mapsetId}`),
  };
});

vi.mock('../utils/osuParser', () => ({
  validateOsuFile: vi.fn((content: string) => {
    if (content === 'invalid') return 'Missing [HitObjects] section';
    return null;
  }),
  parseOsuFile: vi.fn((content: string) => ({ content })),
  buildCandidateBase: vi.fn(() => 'base-content'),
  // Existing tests don't exercise sanitization (callers don't pass
  // sectionRange), so we return changed=false so the upload proceeds.
  sanitizeSectionUpload: vi.fn((parsed: { content: string }) => ({
    content: parsed.content,
    dropped: { hitObjects: 0, timingPoints: 0, breaks: 0 },
    changed: false,
  })),
  MAX_OSU_BYTES: 1 * 1024 * 1024,
}));

vi.mock('../utils/osuBase', () => ({
  diffBase: vi.fn(() => ({
    critical: [],
    notice: [],
    values: {},
    hasDiff: false,
  })),
  normalizeFromBase: vi.fn((section: string) => section),
}));

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

function renderButton(props?: Partial<React.ComponentProps<typeof OsuUploadButton>>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OsuUploadButton
        difficultyId="d1"
        sectionId="s1"
        mapsetId="ms1"
        role="owner"
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('OsuUploadButton', () => {
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
    vi.mocked(diffBase).mockReset();
    vi.mocked(diffBase).mockReturnValue({
      critical: [],
      notice: [],
      values: {},
      hasDiff: false,
    });
    vi.mocked(normalizeFromBase).mockImplementation((section: string) => section);
  });

  it('renders upload button', () => {
    renderButton();
    expect(screen.getByRole('button', { name: /Upload \.osu/i })).toBeInTheDocument();
  });

  it('shows error when mapset is locked', async () => {
    mockIsUnlocked.mockReturnValue(false);
    renderButton();
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/locked/i);
    });
  });

  it('shows error for invalid file', async () => {
    renderButton();
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['invalid'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Missing \[HitObjects\]/i);
    });
  });

  it('blocks upload when role is null (read-only fallback)', async () => {
    renderButton({ role: null });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/doesn't allow uploading/i);
    });
    expect(mockUploadSectionOsu).not.toHaveBeenCalled();
  });

  it('blocks modder uploads at the role gate (matches backend 403)', async () => {
    // Modders are review-only per spec; the backend
    // (upload_section_osu) also returns 403. Verify the frontend never
    // even reaches the diff/modal code, regardless of whether a base
    // exists — otherwise a modder would walk through the modal flow
    // only to hit a 403 they can't recover from.
    renderButton({ role: 'modder' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/doesn't allow uploading/i);
    });
    expect(mockUploadSectionOsu).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('owner can seed the first base (404 path)', async () => {
    renderButton({ role: 'owner' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(1);
    });
    const payload = mockUploadSectionOsu.mock.calls[0][2];
    expect(payload.base_version).toBeDefined();
  });

  it('mapper cannot seed the first base (404 path)', async () => {
    renderButton({ role: 'mapper' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/only the mapset owner/i);
    });
    expect(mockUploadSectionOsu).not.toHaveBeenCalled();
  });

  it('uploads section only when no diff detected', async () => {
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });
    renderButton({ role: 'mapper' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(1);
    });
    const payload = mockUploadSectionOsu.mock.calls[0][2];
    expect(payload.base_version).toBeUndefined();
  });

  it('owner sees critical modal and sends section + base on confirm', async () => {
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: [],
      values: { 'Difficulty:HPDrainRate': { candidate: '9', active: '4' } },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });
    renderButton({ role: 'owner' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(screen.getByText(/CRITICAL: Are you sure/i)).toBeInTheDocument();
    // Value diff visible: base 4, yours 9.
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Promote to base/i }));
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(1);
    });
    const payload = mockUploadSectionOsu.mock.calls[0][2];
    expect(payload.base_version).toBeDefined();
  });

  it('owner critical Discard normalizes both scopes, no new base, banner shown', async () => {
    const { diffBase, normalizeFromBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: [],
      values: { 'Difficulty:HPDrainRate': { candidate: '9', active: '4' } },
      hasDiff: true,
    });
    vi.mocked(normalizeFromBase).mockReturnValue('normalized-critical');
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });
    renderButton({ role: 'owner' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Discard my changes/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Discard my changes/i }));
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(1);
    });
    // Both scopes normalized — closes the critical+notice footgun.
    expect(normalizeFromBase).toHaveBeenCalledWith('osu content [HitObjects]', 'base', {
      critical: true,
      notice: true,
    });
    const payload = mockUploadSectionOsu.mock.calls[0][2];
    expect(payload.base_version).toBeUndefined();
    await waitFor(() => {
      expect(screen.getByText(/Your critical changes to Difficulty:HPDrainRate were discarded/)).toBeInTheDocument();
    });
  });

  it('mapper sees critical modal and sends normalized section only on confirm', async () => {
    const { diffBase, normalizeFromBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: [],
      values: { 'Difficulty:HPDrainRate': { candidate: '9', active: '4' } },
      hasDiff: true,
    });
    vi.mocked(normalizeFromBase).mockReturnValue('normalized-content');
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });
    renderButton({ role: 'mapper' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(screen.getByText(/Differs from Base/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /I'm aware/i }));
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(1);
    });
    expect(normalizeFromBase).toHaveBeenCalledWith('osu content [HitObjects]', 'base', {
      critical: true,
      notice: true,
    });
    const payload = mockUploadSectionOsu.mock.calls[0][2];
    expect(payload.base_version).toBeUndefined();
  });

  it('combined critical+notice Discard: normalizes BOTH and banner lists both', async () => {
    // Closes the footgun: previously, Discard on a combined diff only
    // normalized critical, silently keeping notice changes in the
    // section. Now both buckets get normalized and the banner names
    // everything that was rolled back.
    const { diffBase, normalizeFromBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: ['General:PreviewTime', 'Events'],
      values: {
        'Difficulty:HPDrainRate': { candidate: '9', active: '4' },
        'General:PreviewTime': { candidate: '8000', active: '-1' },
      },
      hasDiff: true,
    });
    vi.mocked(normalizeFromBase).mockReturnValue('fully-normalized');
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });
    renderButton({ role: 'owner' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Discard my changes/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Discard my changes/i }));
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(1);
    });
    expect(normalizeFromBase).toHaveBeenCalledWith('osu content [HitObjects]', 'base', {
      critical: true,
      notice: true,
    });
    const payload = mockUploadSectionOsu.mock.calls[0][2];
    expect(payload.base_version).toBeUndefined();
    await waitFor(() => {
      const banner = screen.getByText(/were discarded/);
      expect(banner).toHaveTextContent(/Difficulty:HPDrainRate/);
      expect(banner).toHaveTextContent(/General:PreviewTime/);
      expect(banner).toHaveTextContent(/Events/);
    });
  });

  it('cancels critical upload from modal', async () => {
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: [],
      values: { 'Difficulty:HPDrainRate': { candidate: '9', active: '4' } },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });
    renderButton({ role: 'owner' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(mockUploadSectionOsu).not.toHaveBeenCalled();
  });

  it('mapper notice-only diff: no modal, silent normalize, no new base, warning shown', async () => {
    const { diffBase, normalizeFromBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: [],
      notice: ['General:PreviewTime'],
      values: { 'General:PreviewTime': { candidate: '8000', active: '-1' } },
      hasDiff: true,
    });
    vi.mocked(normalizeFromBase).mockReturnValue('normalized-section');
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });
    renderButton({ role: 'mapper' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(normalizeFromBase).toHaveBeenCalledWith('osu content [HitObjects]', 'base', {
      critical: false,
      notice: true,
    });
    const payload = mockUploadSectionOsu.mock.calls[0][2];
    expect(payload.base_version).toBeUndefined();
    await waitFor(() => {
      expect(screen.getByText(/Your changes to General:PreviewTime were discarded/)).toBeInTheDocument();
    });
  });

  it('owner notice-only diff: opens owner-notice modal with Promote + Normalize', async () => {
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: [],
      notice: ['General:PreviewTime', 'Events'],
      values: { 'General:PreviewTime': { candidate: '8000', active: '-1' } },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });
    renderButton({ role: 'owner' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(screen.getByText(/Notice changes detected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Promote to base/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Discard my changes/i })).toBeInTheDocument();
    // Value diff for the keyed field, and line-list hint for Events.
    expect(screen.getByText('-1')).toBeInTheDocument();
    expect(screen.getByText('8000')).toBeInTheDocument();
    expect(screen.getByText(/see file/i)).toBeInTheDocument();
    expect(mockUploadSectionOsu).not.toHaveBeenCalled();
  });

  it('owner notice-only diff: Promote sends section + base', async () => {
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: [],
      notice: ['General:PreviewTime'],
      values: { 'General:PreviewTime': { candidate: '8000', active: '-1' } },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });
    renderButton({ role: 'owner' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Promote to base/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Promote to base/i }));
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(1);
    });
    const payload = mockUploadSectionOsu.mock.calls[0][2];
    expect(payload.base_version).toBeDefined();
  });

  it('owner notice-only diff: Cancel closes modal without uploading', async () => {
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: [],
      notice: ['General:PreviewTime'],
      values: { 'General:PreviewTime': { candidate: '8000', active: '-1' } },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });
    renderButton({ role: 'owner' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(mockUploadSectionOsu).not.toHaveBeenCalled();
  });

  it('combined critical+notice diff: critical modal surfaces notice as "also changed"', async () => {
    // Both buckets diff -> critical modal opens, lists critical fields
    // as the primary list, and surfaces the notice fields in a
    // secondary "also changed" panel so the uploader knows what else
    // is on the table (Promote rolls everything into the new base;
    // Discard normalizes both).
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: ['General:PreviewTime'],
      values: {
        'Difficulty:HPDrainRate': { candidate: '9', active: '4' },
        'General:PreviewTime': { candidate: '8000', active: '-1' },
      },
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });
    renderButton({ role: 'owner' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByText(/CRITICAL: Are you sure/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Difficulty:HPDrainRate/i)).toBeInTheDocument();
    expect(screen.getByText(/Also Changed/i)).toBeInTheDocument();
    expect(screen.getByText(/General:PreviewTime/i)).toBeInTheDocument();
  });

  it('owner notice-only diff: Discard normalizes + no new base + warning', async () => {
    const { diffBase, normalizeFromBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: [],
      notice: ['General:PreviewTime'],
      values: { 'General:PreviewTime': { candidate: '8000', active: '-1' } },
      hasDiff: true,
    });
    vi.mocked(normalizeFromBase).mockReturnValue('normalized-section');
    mockDownloadBaseOsu.mockResolvedValue({ id: 'b1', encrypted_content: 'enc:base' });
    renderButton({ role: 'owner' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Discard my changes/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Discard my changes/i }));
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(1);
    });
    expect(normalizeFromBase).toHaveBeenCalledWith('osu content [HitObjects]', 'base', {
      critical: false,
      notice: true,
    });
    const payload = mockUploadSectionOsu.mock.calls[0][2];
    expect(payload.base_version).toBeUndefined();
    await waitFor(() => {
      expect(screen.getByText(/Your changes to General:PreviewTime were discarded/)).toBeInTheDocument();
    });
  });
});
