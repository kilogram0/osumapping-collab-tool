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
const mockDownloadBaseOsu = vi.fn(async () => {
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
}));

vi.mock('../utils/osuBase', () => ({
  diffBase: vi.fn(() => ({
    critical: [],
    notice: [],
    timingPointsChanged: false,
    hasDiff: false,
  })),
  normalizeCriticalLines: vi.fn((section: string) => section),
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
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReset();
    vi.mocked(diffBase).mockReturnValue({
      critical: [],
      notice: [],
      timingPointsChanged: false,
      hasDiff: false,
    });
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

  it('uploads section without base on first upload (404 base)', async () => {
    renderButton();
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(1);
    });
    const payload = mockUploadSectionOsu.mock.calls[0][2];
    expect(payload.encrypted_content).toMatch(/^enc:/);
    expect(payload.base_version).toBeDefined();
    expect(payload.base_version.encrypted_content).toMatch(/^enc:base-content/);
  });

  it('shows confirmation modal when diff is detected', async () => {
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: [],
      timingPointsChanged: false,
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({
      id: 'b1',
      encrypted_content: 'enc:base',
    });
    renderButton();
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: /Upload Confirmation/i })).toBeInTheDocument();
    expect(screen.getByText(/Critical Changes/i)).toBeInTheDocument();
    expect(screen.getByText(/Difficulty:HPDrainRate/i)).toBeInTheDocument();
  });

  it('cancels upload from modal', async () => {
    const { diffBase } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: [],
      timingPointsChanged: false,
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({
      id: 'b1',
      encrypted_content: 'enc:base',
    });
    renderButton();
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

  it('confirms upload from modal without normalizing critical lines', async () => {
    const { diffBase, normalizeCriticalLines } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: ['General:PreviewTime'],
      timingPointsChanged: false,
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({
      id: 'b1',
      encrypted_content: 'enc:base',
    });
    renderButton();
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Upload Anyway/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Upload Anyway/i }));
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(1);
    });
    expect(normalizeCriticalLines).not.toHaveBeenCalled();
  });

  it('normalizes critical lines when checkbox is checked before confirming', async () => {
    const { diffBase, normalizeCriticalLines } = await import('../utils/osuBase');
    vi.mocked(diffBase).mockReturnValue({
      critical: ['Difficulty:HPDrainRate'],
      notice: [],
      timingPointsChanged: false,
      hasDiff: true,
    });
    mockDownloadBaseOsu.mockResolvedValue({
      id: 'b1',
      encrypted_content: 'enc:base',
    });
    renderButton();
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File(['osu content [HitObjects]'], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    const checkbox = screen.getByRole('checkbox', { name: /Normalize critical lines/i });
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: /Upload Anyway/i }));
    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(1);
    });
    expect(normalizeCriticalLines).toHaveBeenCalled();
  });

  it('uploads section only when no diff detected', async () => {
    mockDownloadBaseOsu.mockResolvedValue({
      id: 'b1',
      encrypted_content: 'enc:base',
    });
    renderButton();
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
});
