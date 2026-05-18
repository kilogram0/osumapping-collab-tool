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

  it('renders modal with name and end time inputs only', () => {
    renderModal();
    expect(screen.getByRole('heading', { name: /Add Section/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/End Time/i)).toBeInTheDocument();
    // Start time is read-only computed text
    expect(screen.getByText(/00:00:000/)).toBeInTheDocument();
    expect(screen.getByText(/computed automatically/)).toBeInTheDocument();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('submits encrypted section with correct end time', async () => {
    const onSuccess = vi.fn();
    renderModal({ onSuccess });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Name/i), 'Kiai 1');
    await user.type(screen.getByLabelText(/End Time/i), '00:01:250');
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

  it('shows error for invalid end time format', async () => {
    renderModal();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Name/i), 'Bad');
    await user.type(screen.getByLabelText(/End Time/i), 'not-a-time');
    await user.click(screen.getByRole('button', { name: /Add Section/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Invalid end time format/i);
    });
    expect(mockCreateSection).not.toHaveBeenCalled();
  });

  it('shows error for end time before computed start time', async () => {
    renderModal({
      previousSections: [
        { id: 's-prev', endTimeMs: 125000, sortOrder: 0 },
      ],
    });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Name/i), 'Bad');
    await user.type(screen.getByLabelText(/End Time/i), '00:01:000');
    await user.click(screen.getByRole('button', { name: /Add Section/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/after the automatically computed start time/i);
    });
    expect(mockCreateSection).not.toHaveBeenCalled();
  });

  it('computes start time from previous sections', () => {
    renderModal({
      previousSections: [
        { id: 's-prev', endTimeMs: 125000, sortOrder: 0 },
      ],
    });

    expect(screen.getByText(/02:05:000/)).toBeInTheDocument();
    expect(screen.getByText(/computed automatically/)).toBeInTheDocument();
  });

  it('defaults start time to 0 when no previous sections exist', () => {
    renderModal({ previousSections: [] });
    expect(screen.getByText(/00:00:000/)).toBeInTheDocument();
  });

  it('assigns sort_order as max(previousSections.sortOrder) + 1', async () => {
    renderModal({
      previousSections: [
        { id: 's-a', endTimeMs: 30000, sortOrder: 0 },
        { id: 's-b', endTimeMs: 60000, sortOrder: 3 },
        { id: 's-c', endTimeMs: 125000, sortOrder: 1 },
      ],
    });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Name/i), 'Next');
    await user.type(screen.getByLabelText(/End Time/i), '03:00:000');
    await user.click(screen.getByRole('button', { name: /Add Section/i }));

    await waitFor(() => {
      expect(mockCreateSection).toHaveBeenCalledTimes(1);
    });

    const payload = mockCreateSection.mock.calls[0][0];
    // Encrypted via the mocked encrypt() => `enc:${plaintext}`; the plaintext
    // is the JSON envelope {"v":0,"ms":<order>}.  Max existing sortOrder is 3,
    // so the new section must be 4 — regression guard against the order=0 bug.
    expect(payload.encrypted_sort_order).toBe('enc:{"v":0,"ms":4}');
  });

  it('shows error when encryption key is missing', async () => {
    mockGetKey.mockResolvedValue(null);
    renderModal();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Name/i), 'Intro');
    await user.type(screen.getByLabelText(/End Time/i), '00:00:500');
    await user.click(screen.getByRole('button', { name: /Add Section/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/key not found/i);
    });
    expect(mockCreateSection).not.toHaveBeenCalled();
  });
});
