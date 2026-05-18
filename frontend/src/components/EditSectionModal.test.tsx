import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EditSectionModal from './EditSectionModal';

const mockGetKey = vi.fn(async () => ({ key: 'mock-key' } as unknown as CryptoKey));
const mockUpdateSection = vi.fn(async () => ({
  id: 's1',
  difficulty_id: 'd1',
  encrypted_name: 'enc:Kiai',
  encrypted_start_time_ms: 'enc:0',
  encrypted_end_time_ms: 'enc:30000',
  encrypted_sort_order: 'enc:0',
  created_at: '',
  updated_at: '',
}));

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    getKey: mockGetKey,
  }),
}));

vi.mock('../hooks/useDifficulty', () => ({
  useUpdateSection: () => ({
    mutateAsync: (...args: any[]) => mockUpdateSection(...args),
  }),
}));

vi.mock('../utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/crypto')>();
  return {
    ...actual,
    encrypt: vi.fn(async (_key: CryptoKey, plaintext: string, _aad: string) => `enc:${plaintext}`),
    sectionFieldAad: vi.fn((id: string, mapsetId: string) => `Section|${id}|${mapsetId}`),
  };
});

function renderModal(props?: Partial<React.ComponentProps<typeof EditSectionModal>>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EditSectionModal
        difficultyId="d1"
        mapsetId="ms1"
        sectionId="s1"
        initialName="Intro"
        initialStartTimeMs={0}
        initialEndTimeMs={30000}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('EditSectionModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetKey.mockResolvedValue({ key: 'mock-key' } as unknown as CryptoKey);
  });

  it('renders modal with name and end time inputs only', () => {
    renderModal();
    expect(screen.getByRole('heading', { name: /Edit Section/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/i)).toHaveValue('Intro');
    expect(screen.getByLabelText(/End Time/i)).toHaveValue('00:30:000');
    expect(screen.getByText(/00:00:000/)).toBeInTheDocument();
    expect(screen.getByText(/computed from previous section/)).toBeInTheDocument();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('submits encrypted section with updated end time', async () => {
    const onSuccess = vi.fn();
    renderModal({ onSuccess });
    const user = userEvent.setup();

    await user.clear(screen.getByLabelText(/End Time/i));
    await user.type(screen.getByLabelText(/End Time/i), '00:45:500');
    await user.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      expect(mockUpdateSection).toHaveBeenCalledTimes(1);
    });

    const args = mockUpdateSection.mock.calls[0][0];
    expect(args.sectionId).toBe('s1');
    expect(args.payload.encrypted_name).toMatch(/^enc:Intro/);
    expect(args.payload.encrypted_end_time_ms).toMatch(/^enc:/);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('shows error for invalid end time format', async () => {
    renderModal();
    const user = userEvent.setup();

    await user.clear(screen.getByLabelText(/End Time/i));
    await user.type(screen.getByLabelText(/End Time/i), 'bad');
    await user.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Invalid end time format/i);
    });
    expect(mockUpdateSection).not.toHaveBeenCalled();
  });

  it('shows error when end time is before start time', async () => {
    renderModal({ initialStartTimeMs: 60000, initialEndTimeMs: 90000 });
    const user = userEvent.setup();

    await user.clear(screen.getByLabelText(/End Time/i));
    await user.type(screen.getByLabelText(/End Time/i), '00:00:500');
    await user.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/after the section start time/i);
    });
    expect(mockUpdateSection).not.toHaveBeenCalled();
  });

  it('shows error when encryption key is missing', async () => {
    mockGetKey.mockResolvedValue(null);
    renderModal();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/key not found/i);
    });
    expect(mockUpdateSection).not.toHaveBeenCalled();
  });
});
