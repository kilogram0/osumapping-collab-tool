import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CreateDifficultyModal from './CreateDifficultyModal';

const mockGetKey = vi.fn(async () => ({ key: 'mock-key' } as unknown as CryptoKey));
const mockCreateDifficulty = vi.fn(async () => ({
  id: 'd1',
  mapset_id: 'ms1',
  encrypted_name: 'enc:Hard',
  created_at: '',
  updated_at: '',
}));

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    getKey: mockGetKey,
  }),
}));

vi.mock('../hooks/useDifficulty', () => ({
  useCreateDifficulty: () => ({
    mutateAsync: (...args: any[]) => mockCreateDifficulty(...args),
  }),
}));

vi.mock('../utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/crypto')>();
  return {
    ...actual,
    encrypt: vi.fn(async (_key: CryptoKey, plaintext: string, _aad: string) => `enc:${plaintext}`),
    difficultyFieldAad: vi.fn((id: string, mapsetId: string) => `Difficulty|${id}|${mapsetId}`),
  };
});

function renderModal(props?: Partial<React.ComponentProps<typeof CreateDifficultyModal>>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CreateDifficultyModal
        mapsetId="ms1"
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('CreateDifficultyModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetKey.mockResolvedValue({ key: 'mock-key' } as unknown as CryptoKey);
  });

  it('renders modal with name input', () => {
    renderModal();
    expect(screen.getByRole('heading', { name: /Add Difficulty/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/i)).toBeInTheDocument();
  });

  it('submits encrypted difficulty name', async () => {
    const onSuccess = vi.fn();
    renderModal({ onSuccess });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Name/i), 'Insane');
    await user.click(screen.getByRole('button', { name: /Add Difficulty/i }));

    await waitFor(() => {
      expect(mockCreateDifficulty).toHaveBeenCalledTimes(1);
    });

    const payload = mockCreateDifficulty.mock.calls[0][0];
    expect(payload.encrypted_name).toMatch(/^enc:Insane/);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
