import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CreateSectionModal from './CreateSectionModal';

const mockGetKey = vi.fn(async () => ({ key: 'mock-key' } as unknown as CryptoKey));
const mockCreateSection = vi.fn(async () => ({
  id: 's1',
  difficulty_id: 'd1',
  encrypted_name: 'enc:Intro',
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
  useCreateSection: () => ({
    mutateAsync: (...args: any[]) => mockCreateSection(...args),
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

function renderModal(props?: Partial<React.ComponentProps<typeof CreateSectionModal>>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CreateSectionModal
        difficultyId="d1"
        mapsetId="ms1"
        previousSections={[]}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('CreateSectionModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetKey.mockResolvedValue({ key: 'mock-key' } as unknown as CryptoKey);
  });

  it('renders modal with all inputs', () => {
    renderModal();
    expect(screen.getByRole('heading', { name: /Add Section/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Start Time Minutes/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Start Time Seconds/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Start Time Milliseconds/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/End Time Minutes/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/End Time Seconds/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/End Time Milliseconds/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Sort Order/i)).not.toBeInTheDocument();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('submits encrypted section with correct time values', async () => {
    const onSuccess = vi.fn();
    renderModal({ onSuccess });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Name/i), 'Kiai 1');
    await user.type(screen.getByLabelText(/Start Time Minutes/i), '0');
    await user.type(screen.getByLabelText(/Start Time Seconds/i), '30');
    await user.type(screen.getByLabelText(/Start Time Milliseconds/i), '500');
    await user.type(screen.getByLabelText(/End Time Minutes/i), '1');
    await user.type(screen.getByLabelText(/End Time Seconds/i), '15');
    await user.type(screen.getByLabelText(/End Time Milliseconds/i), '250');
    await user.click(screen.getByRole('button', { name: /Add Section/i }));

    await waitFor(() => {
      expect(mockCreateSection).toHaveBeenCalledTimes(1);
    });

    const payload = mockCreateSection.mock.calls[0][0];
    expect(payload.encrypted_name).toMatch(/^enc:Kiai 1/);
    expect(payload.encrypted_start_time_ms).toMatch(/^enc:/);
    expect(payload.encrypted_end_time_ms).toMatch(/^enc:/);
    expect(payload.encrypted_sort_order).toMatch(/^enc:/);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('shows error when encryption key is missing', async () => {
    mockGetKey.mockResolvedValue(null);
    renderModal();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Name/i), 'Intro');
    await user.click(screen.getByRole('button', { name: /Add Section/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/key not found/i);
    });
    expect(mockCreateSection).not.toHaveBeenCalled();
  });

  it('auto-fills start time from previous sections', () => {
    renderModal({
      previousSections: [
        { id: 's-prev', endTimeMs: 125000 },
      ],
    });

    expect(screen.getByLabelText(/Start Time Minutes/i)).toHaveValue(2);
    expect(screen.getByLabelText(/Start Time Seconds/i)).toHaveValue(5);
    expect(screen.getByLabelText(/Start Time Milliseconds/i)).toHaveValue(0);
  });

  it('defaults start time to 0 when no previous sections exist', () => {
    renderModal({ previousSections: [] });

    expect(screen.getByLabelText(/Start Time Minutes/i)).toHaveValue(0);
    expect(screen.getByLabelText(/Start Time Seconds/i)).toHaveValue(0);
    expect(screen.getByLabelText(/Start Time Milliseconds/i)).toHaveValue(0);
  });

  it('rejects end time before start time', async () => {
    renderModal();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Name/i), 'Bad');
    await user.type(screen.getByLabelText(/End Time Minutes/i), '0');
    await user.type(screen.getByLabelText(/End Time Seconds/i), '0');
    await user.type(screen.getByLabelText(/End Time Milliseconds/i), '0');
    await user.click(screen.getByRole('button', { name: /Add Section/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/after start time/i);
    });
    expect(mockCreateSection).not.toHaveBeenCalled();
  });
});
