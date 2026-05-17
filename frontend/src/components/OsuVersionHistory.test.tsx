import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import OsuVersionHistory from './OsuVersionHistory';

const mockVersions = [
  { id: 'v2', version: 2, is_active: true, uploaded_by: 'user-1', created_at: '2024-01-02T00:00:00Z' },
  { id: 'v1', version: 1, is_active: false, uploaded_by: 'user-1', created_at: '2024-01-01T00:00:00Z' },
];

const mockFetch = vi.fn(() => ({ data: mockVersions, isLoading: false, error: null }));
const mockActivate = vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false }));

const mockBaseFetch = vi.fn(() => ({ data: [] }));

vi.mock('../hooks/useDifficulty', () => ({
  useSectionOsuVersions: (...args: any[]) => mockFetch(...args),
  useActivateSectionOsuVersion: () => mockActivate(),
  useBaseOsuVersions: (...args: any[]) => mockBaseFetch(...args),
}));

function renderComponent(props?: Partial<React.ComponentProps<typeof OsuVersionHistory>>) {
  return render(
    <OsuVersionHistory
      difficultyId="d1"
      sectionId="s1"
      onClose={vi.fn()}
      {...props}
    />,
  );
}

describe('OsuVersionHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReturnValue({ data: mockVersions, isLoading: false, error: null });
    mockBaseFetch.mockReturnValue({ data: [] });
    mockActivate.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  });

  it('renders version list', () => {
    renderComponent();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Section Version History')).toBeInTheDocument();
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
    expect(screen.getByText(/No versions uploaded yet/i)).toBeInTheDocument();
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
      expect(mutateAsync).toHaveBeenCalledWith('v1');
    });
  });

  it('shows base-created badge when version created a base', () => {
    mockBaseFetch.mockReturnValue({
      data: [{ id: 'b1', version: 1, is_active: false, source_section_version_id: 'v2', created_at: '' }],
    });
    renderComponent();
    expect(screen.getByTitle(/Originally created Base v1 on upload/i)).toBeInTheDocument();
  });
});
