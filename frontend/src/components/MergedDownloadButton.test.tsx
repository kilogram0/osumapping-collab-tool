import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import MergedDownloadButton from './MergedDownloadButton';
import type { Section } from '../api/endpoints';

const mockIsUnlocked = vi.fn(() => true);
const mockGetKey = vi.fn(async () => ({} as CryptoKey));

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

const mockDownloadBaseOsu = vi.fn();
const mockDownloadSectionOsu = vi.fn();
vi.mock('../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/endpoints')>();
  return {
    ...actual,
    downloadBaseOsu: (...args: unknown[]) => mockDownloadBaseOsu(...args),
    downloadSectionOsu: (...args: unknown[]) => mockDownloadSectionOsu(...args),
  };
});

vi.mock('../utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/crypto')>();
  return {
    ...actual,
    decrypt: vi.fn(async (_key: CryptoKey, ciphertext: string) => ciphertext),
    decodeJsonEnvelope: vi.fn((v: string) => Number(v)),
  };
});

vi.mock('../utils/osuMerge', () => ({ mergeOsu: vi.fn(() => 'merged-osu') }));
vi.mock('../utils/osuParser', () => ({
  parseOsuFile: vi.fn((c: string) => ({ raw: c })),
  withMetadataVersion: vi.fn((_parsed: unknown, diffName: string) => ({
    content: `content-${diffName}`,
    metadata: { artist: 'Artist', title: 'Title' },
  })),
}));
vi.mock('../utils/osuFilename', () => ({
  composeOsuFilename: vi.fn(({ diffName }: { diffName: string }) => `${diffName}.osu`),
}));
vi.mock('../utils/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

function section(id: string): Section {
  return {
    id,
    difficulty_id: 'd1',
    encrypted_name: 'enc',
    encrypted_sort_order: '0',
    encrypted_end_time_ms: '1000',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  } as unknown as Section;
}

const BASE_RESP = { id: 'base1', version: 3, encrypted_content: 'base-cipher' };

function setup(overrides: Partial<React.ComponentProps<typeof MergedDownloadButton>> = {}) {
  const props = {
    difficultyId: 'd1',
    mapsetId: 'ms1',
    mapsetTitle: 'My Mapset',
    sections: [section('s1')],
    difficultyName: 'Insane',
    ...overrides,
  };
  render(<MergedDownloadButton {...props} />);
  return props;
}

describe('MergedDownloadButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsUnlocked.mockReturnValue(true);
    mockDownloadBaseOsu.mockResolvedValue(BASE_RESP);
    mockDownloadSectionOsu.mockResolvedValue({ id: 'sv1', encrypted_content: 'sec-cipher' });
    // jsdom lacks object URL plumbing; stub it so saveOsu() doesn't throw.
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('opens a menu with Base Template and Full diff options', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByRole('menu')).toBeNull();

    await user.click(screen.getByRole('button', { name: /download/i }));

    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Base Template' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Full diff' })).toBeInTheDocument();
  });

  it('downloads only the base when Base Template is chosen', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: /download/i }));
    await user.click(screen.getByRole('menuitem', { name: 'Base Template' }));

    await waitFor(() => expect(mockDownloadBaseOsu).toHaveBeenCalledWith('d1'));
    // Base-only must not pull section content.
    expect(mockDownloadSectionOsu).not.toHaveBeenCalled();
    // Menu closes after selecting.
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('assembles base + sections when Full diff is chosen', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: /download/i }));
    await user.click(screen.getByRole('menuitem', { name: 'Full diff' }));

    await waitFor(() => expect(mockDownloadSectionOsu).toHaveBeenCalledWith('d1', 's1'));
    expect(mockDownloadBaseOsu).toHaveBeenCalledWith('d1');
  });

  it('disables Full diff when there are no sections', async () => {
    const user = userEvent.setup();
    setup({ sections: [] });

    await user.click(screen.getByRole('button', { name: /download/i }));

    expect(screen.getByRole('menuitem', { name: 'Full diff' })).toBeDisabled();
    // Base Template is still available with zero sections.
    expect(screen.getByRole('menuitem', { name: 'Base Template' })).toBeEnabled();
  });

  it('disables the trigger while the mapset is locked', () => {
    mockIsUnlocked.mockReturnValue(false);
    setup();
    expect(screen.getByRole('button', { name: /download/i })).toBeDisabled();
  });

  it('closes the menu on outside click and on Escape', async () => {
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByRole('button', { name: /download/i });

    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();

    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows the assembling label and disables the trigger during a download', async () => {
    const user = userEvent.setup();
    // Hold the base fetch open so the in-flight state is observable.
    let resolveBase!: (v: typeof BASE_RESP) => void;
    mockDownloadBaseOsu.mockReturnValue(new Promise((res) => { resolveBase = res; }));
    setup();

    await user.click(screen.getByRole('button', { name: /download/i }));
    await user.click(screen.getByRole('menuitem', { name: 'Base Template' }));

    const trigger = screen.getByRole('button', { name: /download/i });
    await waitFor(() => expect(trigger).toHaveTextContent('Assembling…'));
    expect(trigger).toBeDisabled();

    resolveBase(BASE_RESP);
    await waitFor(() => expect(trigger).not.toBeDisabled());
    expect(trigger).toHaveTextContent('Download');
  });
});
