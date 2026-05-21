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

const mockScheduleMutate = vi.fn();
const mockCancelMutate = vi.fn();

vi.mock('../hooks/useMapset', () => ({
  useScheduleMapsetDeletion: () => ({ mutate: mockScheduleMutate }),
  useCancelMapsetDeletion: () => ({ mutate: mockCancelMutate }),
}));

const mockUser = { id: 'owner-uuid', username: 'owner', osu_id: 1, avatar_url: '', created_at: '', updated_at: '' };

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const MAPSET: Mapset = {
  id: 'test-mapset-id',
  title: 'Test Mapset',
  encrypted_description: null,
  encrypted_song_length_ms: 'encrypted:0',
  passphrase_salt: 'c2FsdA==',
  encrypted_verification: 'encrypted:verified',
  owner_id: 'owner-uuid',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  delete_at: null,
  difficulty_count: 0,
};

const MAPSET_PENDING: Mapset = {
  ...MAPSET,
  delete_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
};

function renderCard(mapset: Mapset = MAPSET, onUnlock?: (m: Mapset) => void) {
  return render(
    <MemoryRouter>
      <MapsetCard mapset={mapset} onUnlock={onUnlock} />
    </MemoryRouter>,
  );
}

describe('MapsetCard (locked)', () => {
  beforeEach(() => {
    mockIsUnlocked.mockReturnValue(false);
    mockGetKey.mockResolvedValue(null);
    mockNavigate.mockReset();
    mockScheduleMutate.mockReset();
    mockCancelMutate.mockReset();
  });

  it('renders the mapset title', () => {
    renderCard();
    expect(screen.getByText(MAPSET.title)).toBeInTheDocument();
  });

  it('shows Unlock button when onUnlock prop is provided', () => {
    renderCard(MAPSET, vi.fn());
    expect(screen.getByRole('button', { name: /unlock mapset/i })).toBeInTheDocument();
  });

  it('calls onUnlock with the mapset when Unlock is clicked', async () => {
    const onUnlock = vi.fn();
    renderCard(MAPSET, onUnlock);
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
    renderCard(MAPSET, vi.fn());
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /unlock/i })).toBeNull();
  });

  it('renders the mapset title when unlocked', () => {
    renderCard();
    expect(screen.getByText(MAPSET.title)).toBeInTheDocument();
  });
});

describe('MapsetCard three-dot menu (owner)', () => {
  beforeEach(() => {
    mockIsUnlocked.mockReturnValue(false);
    mockNavigate.mockReset();
    mockScheduleMutate.mockReset();
    mockCancelMutate.mockReset();
  });

  it('shows the menu button for the owner', () => {
    renderCard();
    expect(screen.getByTestId('mapset-menu-button')).toBeInTheDocument();
  });

  it('opens the menu on menu button click', async () => {
    renderCard();
    await userEvent.click(screen.getByTestId('mapset-menu-button'));
    expect(screen.getByTestId('mapset-menu')).toBeInTheDocument();
  });

  it('shows Delete option when no deletion is scheduled', async () => {
    renderCard();
    await userEvent.click(screen.getByTestId('mapset-menu-button'));
    expect(screen.getByTestId('schedule-delete-button')).toBeInTheDocument();
  });

  it('clicking Delete calls scheduleDelete mutation', async () => {
    renderCard();
    await userEvent.click(screen.getByTestId('mapset-menu-button'));
    await userEvent.click(screen.getByTestId('schedule-delete-button'));
    expect(mockScheduleMutate).toHaveBeenCalledWith(MAPSET.id);
  });

  it('shows Cancel deletion option when deletion is pending', async () => {
    renderCard(MAPSET_PENDING);
    await userEvent.click(screen.getByTestId('mapset-menu-button'));
    expect(screen.getByTestId('cancel-delete-button')).toBeInTheDocument();
  });

  it('clicking Cancel deletion calls cancelDelete mutation', async () => {
    renderCard(MAPSET_PENDING);
    await userEvent.click(screen.getByTestId('mapset-menu-button'));
    await userEvent.click(screen.getByTestId('cancel-delete-button'));
    expect(mockCancelMutate).toHaveBeenCalledWith(MAPSET_PENDING.id);
  });

  it('menu button click does not navigate', async () => {
    renderCard();
    await userEvent.click(screen.getByTestId('mapset-menu-button'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows deletion countdown when deletion is pending', () => {
    renderCard(MAPSET_PENDING);
    expect(screen.getByText(/scheduled for deletion in/i)).toBeInTheDocument();
  });

  it('shows "Deletion imminent" when delete_at is in the past', () => {
    const overdue = { ...MAPSET_PENDING, delete_at: new Date(Date.now() - 1000).toISOString() };
    renderCard(overdue);
    expect(screen.getByText(/deletion imminent/i)).toBeInTheDocument();
  });

  it('shows red border when deletion is pending', () => {
    renderCard(MAPSET_PENDING);
    expect(screen.getByTestId('mapset-card')).toHaveClass('border-red-500/60');
  });

  it('closes the menu on Escape key', async () => {
    renderCard();
    await userEvent.click(screen.getByTestId('mapset-menu-button'));
    expect(screen.getByTestId('mapset-menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('mapset-menu')).toBeNull();
  });
});

describe('MapsetCard three-dot menu (non-owner)', () => {
  it('does not show menu button for non-owners', () => {
    const nonOwnerMapset = { ...MAPSET, owner_id: 'someone-else' };
    render(
      <MemoryRouter>
        <MapsetCard mapset={nonOwnerMapset} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('mapset-menu-button')).toBeNull();
  });
});
