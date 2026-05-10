import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import MapsetCard from './MapsetCard';
import type { Mapset } from '../api/endpoints';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockIsUnlocked = vi.fn(() => false);
const mockGetKey = vi.fn(async () => null);

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

const MAPSET: Mapset = {
  id: 'test-mapset-id',
  encrypted_title: 'encrypted:title',
  encrypted_description: null,
  encrypted_song_length_ms: 'encrypted:0',
  passphrase_salt: 'c2FsdA==',
  encrypted_verification: 'encrypted:verified',
  owner_id: 'owner-uuid',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

function renderCard(onUnlock?: (m: Mapset) => void) {
  return render(
    <MemoryRouter>
      <MapsetCard mapset={MAPSET} onUnlock={onUnlock} />
    </MemoryRouter>,
  );
}

describe('MapsetCard (locked)', () => {
  beforeEach(() => {
    mockIsUnlocked.mockReturnValue(false);
    mockGetKey.mockResolvedValue(null);
    mockNavigate.mockReset();
  });

  it('renders locked placeholder text', () => {
    renderCard();
    expect(screen.getByText(/🔒 Encrypted Mapset/i)).toBeInTheDocument();
  });

  it('shows Unlock button when onUnlock prop is provided', () => {
    renderCard(vi.fn());
    expect(screen.getByRole('button', { name: /unlock mapset/i })).toBeInTheDocument();
  });

  it('calls onUnlock with the mapset when Unlock is clicked', async () => {
    const onUnlock = vi.fn();
    renderCard(onUnlock);
    await userEvent.click(screen.getByRole('button', { name: /unlock mapset/i }));
    expect(onUnlock).toHaveBeenCalledWith(MAPSET);
  });

  it('navigates to /mapsets/:id when clicked', async () => {
    renderCard();
    await userEvent.click(screen.getByTestId('mapset-card'));
    expect(mockNavigate).toHaveBeenCalledWith(`/mapsets/${MAPSET.id}`);
  });
});

describe('MapsetCard (unlocked)', () => {
  beforeEach(() => {
    mockIsUnlocked.mockReturnValue(true);
  });

  it('does not show Unlock button when already unlocked', async () => {
    renderCard(vi.fn());
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /unlock/i })).toBeNull();
  });
});
