import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CreateMapsetModal from './CreateMapsetModal';
import { encrypt } from '../utils/crypto';
import { createMapset } from '../api/endpoints';
import { ToastProvider } from '../contexts/ToastContext';
import { parseOszFile } from '../utils/oszParser';

vi.mock('../utils/oszParser', () => ({
  parseOszFile: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({
  createMapset: vi.fn().mockResolvedValue({
    id: 'test-mapset-id',
    title: 'Test Mapset',
    encrypted_description: null,
    encrypted_song_length_ms: 'encrypted-mock',
    passphrase_salt: 'mock-salt',
    encrypted_verification: 'encrypted-verification',
    owner_id: 'owner-uuid',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }),
  fetchMapsets: vi.fn().mockResolvedValue([]),
  fetchMapset: vi.fn().mockResolvedValue(null),
  createDifficulty: vi.fn(),
  createSection: vi.fn(),
  uploadSectionOsu: vi.fn(),
}));

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    unlockWithKey: vi.fn().mockResolvedValue(undefined),
    isUnlocked: vi.fn(() => false),
    getKey: vi.fn().mockResolvedValue(null),
    unlockMapset: vi.fn().mockResolvedValue(undefined),
    lockMapset: vi.fn().mockResolvedValue(undefined),
    clearAll: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../utils/crypto', () => ({
  generatePassphrase: () => 'mock-passphrase-mock-passphrase-mock-passphrase',
  generateSalt: () => 'mock-salt',
  deriveKey: vi.fn().mockResolvedValue({} as CryptoKey),
  encrypt: vi.fn().mockResolvedValue('encrypted-mock'),
  mapsetFieldAad: vi.fn().mockReturnValue('Mapset|id|id'),
  mapsetVerificationAad: vi.fn().mockReturnValue('Mapset|id|id'),
  difficultyFieldAad: vi.fn().mockReturnValue('Difficulty|id|id'),
  sectionFieldAad: vi.fn().mockReturnValue('Section|id|id'),
  sectionOsuVersionAad: vi.fn().mockReturnValue('SectionOsuVersion|id|id'),
  difficultyBaseOsuVersionAad: vi.fn().mockReturnValue('DifficultyBaseOsuVersion|id|id'),
  VERIFICATION_CANARY: 'verified',
}));

function renderModal() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <CreateMapsetModal onSuccess={vi.fn()} onCancel={vi.fn()} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function fillAndSubmit(title: string) {
  await userEvent.type(screen.getByLabelText(/title/i), title);
  await userEvent.click(screen.getByRole('checkbox', { name: /saved this passphrase/i }));
  await userEvent.click(screen.getByRole('button', { name: /create mapset/i }));
  await waitFor(() => {
    expect(vi.mocked(createMapset)).toHaveBeenCalled();
  });
}

describe('CreateMapsetModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders minutes and seconds inputs', () => {
    renderModal();
    expect(screen.getByLabelText(/minutes/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/seconds/i)).toBeInTheDocument();
  });

  it('submits with correct total milliseconds from minutes and seconds', async () => {
    renderModal();
    await userEvent.type(screen.getByLabelText(/minutes/i), '3');
    await userEvent.type(screen.getByLabelText(/seconds/i), '30');
    await fillAndSubmit('Test Mapset');

    const songLengthCall = vi.mocked(encrypt).mock.calls.find(
      (call) => call[1] === '{"v":1,"ms":210000}',
    );
    expect(songLengthCall).toBeDefined();
  });

  it('defaults to 0 ms when minutes and seconds are empty', async () => {
    renderModal();
    await fillAndSubmit('Test Mapset');

    const songLengthCall = vi.mocked(encrypt).mock.calls.find(
      (call) => call[1] === '{"v":1,"ms":0}',
    );
    expect(songLengthCall).toBeDefined();
  });

  it('clamps seconds to 59', async () => {
    renderModal();
    const secondsInput = screen.getByLabelText(/seconds/i) as HTMLInputElement;
    await userEvent.clear(secondsInput);
    await userEvent.type(secondsInput, '75');
    expect(secondsInput.value).toBe('59');
  });

  it('does not clamp large minute values', async () => {
    renderModal();
    const minutesInput = screen.getByLabelText(/minutes/i) as HTMLInputElement;
    await userEvent.clear(minutesInput);
    await userEvent.type(minutesInput, '150');
    expect(minutesInput.value).toBe('150');
  });

  it('rejects negative values by clamping to 0', async () => {
    renderModal();
    const minutesInput = screen.getByLabelText(/minutes/i) as HTMLInputElement;
    await userEvent.clear(minutesInput);
    await userEvent.type(minutesInput, '-5');
    expect(minutesInput.value).toBe('0');
  });

  it('does not submit without title', async () => {
    renderModal();
    await userEvent.click(screen.getByRole('checkbox', { name: /saved this passphrase/i }));
    await userEvent.click(screen.getByRole('button', { name: /create mapset/i }));

    expect(vi.mocked(createMapset)).not.toHaveBeenCalled();
  });

  it('does not submit without passphrase confirmation', async () => {
    renderModal();
    await userEvent.type(screen.getByLabelText(/title/i), 'Test Mapset');
    await userEvent.click(screen.getByRole('button', { name: /create mapset/i }));

    expect(vi.mocked(createMapset)).not.toHaveBeenCalled();
  });
});

function makeOsz(overrides?: Partial<import('../utils/oszParser').ParsedOsz>) {
  return {
    difficulties: [{
      filename: 'Hard.osu',
      content: '',
      parsed: { sections: [], timingPointsSection: null, hitObjectsSection: null, timingPoints: [], hitObjects: [] },
      name: 'Hard',
      bookmarks: [],
    }],
    title: 'Song',
    artist: 'Artist',
    audioFilename: null,
    songLengthMs: 180000, // 3:00
    ...overrides,
  };
}

async function uploadOsz(result: import('../utils/oszParser').ParsedOsz) {
  vi.mocked(parseOszFile).mockResolvedValueOnce(result);
  const file = new File([''], 'test.osz', { type: 'application/zip' });
  await userEvent.upload(screen.getByLabelText(/start from a \.osz/i), file);
  await waitFor(() => {
    expect(vi.mocked(parseOszFile)).toHaveBeenCalled();
  });
}

describe('CreateMapsetModal — OSZ import query invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-invalidates mapsets and quota after OSZ difficulties are imported', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <CreateMapsetModal onSuccess={vi.fn()} onCancel={vi.fn()} />
        </ToastProvider>
      </QueryClientProvider>,
    );

    await uploadOsz(makeOsz());
    await waitFor(() => {
      expect((screen.getByLabelText(/title/i) as HTMLInputElement).value).toBe('Artist - Song');
    });

    await userEvent.click(screen.getByRole('checkbox', { name: /saved this passphrase/i }));
    await userEvent.click(screen.getByRole('button', { name: /create mapset/i }));

    await waitFor(() => {
      type InvalidateArg = { queryKey?: unknown[] };
      const keyAt0 = (call: unknown[]) => (call[0] as InvalidateArg)?.queryKey?.[0];
      const mapsetsCalls = invalidateSpy.mock.calls.filter((c) => keyAt0(c) === 'mapsets');
      const quotaCalls = invalidateSpy.mock.calls.filter((c) => keyAt0(c) === 'quota');
      // Once from useCreateMapset onSuccess, once again after OSZ import finishes
      expect(mapsetsCalls.length).toBe(2);
      expect(quotaCalls.length).toBe(2);
    });
  });
});

describe('CreateMapsetModal — OSZ dirty-field behaviour', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-fills title from first OSZ upload', async () => {
    renderModal();
    await uploadOsz(makeOsz());
    await waitFor(() => {
      expect((screen.getByLabelText(/title/i) as HTMLInputElement).value).toBe('Artist - Song');
    });
  });

  it('auto-fills song length from first OSZ upload', async () => {
    renderModal();
    await uploadOsz(makeOsz());
    await waitFor(() => {
      expect((screen.getByLabelText(/minutes/i) as HTMLInputElement).value).toBe('3');
      expect((screen.getByLabelText(/seconds/i) as HTMLInputElement).value).toBe('0');
    });
  });

  it('replaces title on second OSZ when not dirty', async () => {
    renderModal();
    await uploadOsz(makeOsz({ artist: 'Artist1', title: 'Song1' }));
    await waitFor(() => {
      expect((screen.getByLabelText(/title/i) as HTMLInputElement).value).toBe('Artist1 - Song1');
    });
    await uploadOsz(makeOsz({ artist: 'Artist2', title: 'Song2' }));
    await waitFor(() => {
      expect((screen.getByLabelText(/title/i) as HTMLInputElement).value).toBe('Artist2 - Song2');
    });
  });

  it('replaces song length on second OSZ when not dirty', async () => {
    renderModal();
    await uploadOsz(makeOsz({ songLengthMs: 60000 })); // 1:00
    await waitFor(() => {
      expect((screen.getByLabelText(/minutes/i) as HTMLInputElement).value).toBe('1');
    });
    await uploadOsz(makeOsz({ songLengthMs: 120000 })); // 2:00
    await waitFor(() => {
      expect((screen.getByLabelText(/minutes/i) as HTMLInputElement).value).toBe('2');
      expect((screen.getByLabelText(/seconds/i) as HTMLInputElement).value).toBe('0');
    });
  });

  it('does not replace title on second OSZ when user has edited it', async () => {
    renderModal();
    await uploadOsz(makeOsz({ artist: 'Artist1', title: 'Song1' }));
    await waitFor(() => {
      expect((screen.getByLabelText(/title/i) as HTMLInputElement).value).toBe('Artist1 - Song1');
    });
    const titleInput = screen.getByLabelText(/title/i);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'My Custom Title');
    await uploadOsz(makeOsz({ artist: 'Artist2', title: 'Song2' }));
    // Title should remain what the user typed
    expect((screen.getByLabelText(/title/i) as HTMLInputElement).value).toBe('My Custom Title');
  });

  it('does not replace song length on second OSZ when user has edited minutes', async () => {
    renderModal();
    await uploadOsz(makeOsz({ songLengthMs: 60000 }));
    await waitFor(() => {
      expect((screen.getByLabelText(/minutes/i) as HTMLInputElement).value).toBe('1');
    });
    const minutesInput = screen.getByLabelText(/minutes/i);
    await userEvent.clear(minutesInput);
    await userEvent.type(minutesInput, '5');
    await uploadOsz(makeOsz({ songLengthMs: 120000 }));
    expect((screen.getByLabelText(/minutes/i) as HTMLInputElement).value).toBe('5');
  });

  it('does not replace song length on second OSZ when user has edited seconds', async () => {
    renderModal();
    await uploadOsz(makeOsz({ songLengthMs: 60000 }));
    await waitFor(() => {
      expect((screen.getByLabelText(/seconds/i) as HTMLInputElement).value).toBe('0');
    });
    const secondsInput = screen.getByLabelText(/seconds/i);
    await userEvent.clear(secondsInput);
    await userEvent.type(secondsInput, '30');
    await uploadOsz(makeOsz({ songLengthMs: 120000 }));
    expect((screen.getByLabelText(/seconds/i) as HTMLInputElement).value).toBe('30');
  });
});
