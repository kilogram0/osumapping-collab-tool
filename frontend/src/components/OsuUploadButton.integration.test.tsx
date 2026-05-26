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
// Default: 404 (no active base). Explicit `Promise<unknown>` typing so tests
// that override via mockResolvedValue can pass a partial BaseOsuVersion
// fixture; without it TS infers Promise<never> from the always-throwing body.
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

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

// Real osuParser and osuBase modules are intentionally NOT mocked so the
// parse → buildCandidateBase → diffBase path is exercised end-to-end.

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

const BASE_OSU = `osu file format v14
[General]
AudioFilename: audio.mp3
AudioLeadIn: 0
PreviewTime: 5000
[Metadata]
Title:Test
Artist:Test
Creator:Tester
Version:Normal
[Difficulty]
HPDrainRate:4
CircleSize:4
OverallDifficulty:6
ApproachRate:5
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,2,0,50,1,0
[HitObjects]
64,192,0,1,0
`;

const SECTION_OSU_DIFFERENT_HP = `osu file format v14
[General]
AudioFilename: audio.mp3
AudioLeadIn: 0
PreviewTime: 8000
[Metadata]
Title:Test
Artist:Test
Creator:Tester
Version:Hard
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:6
ApproachRate:5
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,2,0,50,1,0
-100,1.5,4,2,0,50,0,0
[HitObjects]
64,192,0,1,0
128,192,500,1,0
`;

describe('OsuUploadButton integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
    mockGetKey.mockResolvedValue({ key: 'mock-key' } as unknown as CryptoKey);
  });

  it('detects critical diff using real parser and shows owner-critical modal', async () => {
    mockDownloadBaseOsu.mockResolvedValue({
      id: 'b1',
      encrypted_content: 'enc:' + BASE_OSU,
    });

    renderButton({ role: 'owner' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File([SECTION_OSU_DIFFERENT_HP], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    expect(screen.getByText(/Critical Changes/i)).toBeInTheDocument();
    expect(screen.getByText(/Difficulty:HPDrainRate/i)).toBeInTheDocument();
    // PreviewTime is a notice-bucket diff; the owner-critical modal now
    // surfaces it under "Also Changed" so the owner sees what else will
    // roll up into the new base (or get normalized on Discard).
    expect(screen.getByText(/Also Changed/i)).toBeInTheDocument();
    expect(screen.getByText(/General:PreviewTime/i)).toBeInTheDocument();
  });

  it('positive [TimingPoints] change opens the critical modal end-to-end', async () => {
    // Regression guard for the TimingPoints-to-critical reclassification.
    // Before this change, a BPM edit landed in `notice` and silently
    // created a new base; now it must be modal-gated like Difficulty.
    const SECTION_DIFFERENT_BPM = `osu file format v14
[General]
AudioFilename: audio.mp3
AudioLeadIn: 0
PreviewTime: 5000
[Metadata]
Title:Test
Artist:Test
Creator:Tester
Version:Normal
[Difficulty]
HPDrainRate:4
CircleSize:4
OverallDifficulty:6
ApproachRate:5
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,400,4,2,0,50,1,0
[HitObjects]
64,192,0,1,0
`;
    mockDownloadBaseOsu.mockResolvedValue({
      id: 'b1',
      encrypted_content: 'enc:' + BASE_OSU,
    });

    renderButton({ role: 'owner' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File([SECTION_DIFFERENT_BPM], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Critical owner modal — not the silent notice-auto-upload path.
    expect(screen.getByText(/CRITICAL: Are you sure/i)).toBeInTheDocument();
    expect(screen.getByText(/TimingPoints/i)).toBeInTheDocument();
  });

  it('uploads without modal when file matches base exactly', async () => {
    mockDownloadBaseOsu.mockResolvedValue({
      id: 'b1',
      encrypted_content: 'enc:' + BASE_OSU,
    });

    renderButton({ role: 'owner' });
    const user = userEvent.setup();
    const input = screen.getByLabelText(/Upload \.osu file/i);
    const file = new File([BASE_OSU], 'test.osu', { type: 'text/plain' });
    await user.upload(input, file);

    await waitFor(() => {
      expect(mockUploadSectionOsu).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
