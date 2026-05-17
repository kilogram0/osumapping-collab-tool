import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import BaseVersionHistory from './BaseVersionHistory';

const mockVersions = [
  { id: 'bv2', version: 2, is_active: true, source_section_version_id: 'sv2', created_at: '2024-01-02T00:00:00Z' },
  { id: 'bv1', version: 1, is_active: false, source_section_version_id: 'sv1', created_at: '2024-01-01T00:00:00Z' },
];

const mockFetch = vi.fn(() => ({ data: mockVersions, isLoading: false, error: null }));
const mockActivate = vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false }));

vi.mock('../hooks/useDifficulty', () => ({
  useBaseOsuVersions: (...args: any[]) => mockFetch(...args),
  useActivateBaseOsuVersion: () => mockActivate(),
}));

function renderComponent(props?: Partial<React.ComponentProps<typeof BaseVersionHistory>>) {
  return render(
    <BaseVersionHistory
      difficultyId="d1"
      onClose={vi.fn()}
      {...props}
    />,
  );
}

describe('BaseVersionHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReturnValue({ data: mockVersions, isLoading: false, error: null });
    mockActivate.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  });

  it('renders version list', () => {
    renderComponent();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Base Version History')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('v1')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    mockFetch.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderComponent();
    expect(screen.getByText(/Loading versions/i)).toBeInTheDocument();
  });

  it('shows empty state', () => {
    mockFetch.mockReturnValue({ data: [], isLoading: false, error: null });
    renderComponent();
    expect(screen.getByText(/No base versions yet/i)).toBeInTheDocument();
  });

  it('calls onClose when Close button clicked', async () => {
    const onClose = vi.fn();
    renderComponent({ onClose });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when Escape pressed', async () => {
    const onClose = vi.fn();
    renderComponent({ onClose });
    const user = userEvent.setup();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('activates a version when button clicked', async () => {
    const mutateAsync = vi.fn();
    mockActivate.mockReturnValue({ mutateAsync, isPending: false });
    renderComponent();
    const user = userEvent.setup();
    const activateBtn = screen.getByRole('button', { name: /Activate/i });
    await user.click(activateBtn);
    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith('bv1');
    });
  });
});
