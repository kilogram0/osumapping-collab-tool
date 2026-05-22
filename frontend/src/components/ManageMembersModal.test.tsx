import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ManageMembersModal from './ManageMembersModal';
import type { MemberWithUser } from '../api/endpoints';

const OWNER: MemberWithUser = {
  id: 'm1',
  mapset_id: 'ms1',
  user_id: 'owner-id',
  role: 'owner',
  kicked_at: null,
  created_at: '',
  updated_at: '',
  username: 'OwnerUser',
  avatar_url: 'https://example.com/a.png',
  osu_id: 1,
};

const MODDER: MemberWithUser = {
  id: 'm2',
  mapset_id: 'ms1',
  user_id: 'modder-id',
  role: 'modder',
  kicked_at: null,
  created_at: '',
  updated_at: '',
  username: 'ModderUser',
  avatar_url: 'https://example.com/b.png',
  osu_id: 2,
};

const mockGetPassphrase = vi.fn((_id: string): string | null => null);
const mockInvite = vi.fn(async (_u: string) => MODDER);
const mockUpdateRole = vi.fn(async (_args: { userId: string; role: string }) => MODDER);
const mockRemove = vi.fn(async (_userId: string) => undefined);
let membersData: MemberWithUser[] = [OWNER, MODDER];

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    getPassphrase: mockGetPassphrase,
  }),
}));

vi.mock('../hooks/useMapset', () => ({
  useMembers: () => ({ data: membersData, isLoading: false, isError: false }),
  useInviteMember: () => ({
    mutateAsync: (u: string) => mockInvite(u),
    isPending: false,
  }),
  useUpdateMemberRole: () => ({
    mutateAsync: (args: { userId: string; role: string }) => mockUpdateRole(args),
    isPending: false,
  }),
  useRemoveMember: () => ({
    mutateAsync: (id: string) => mockRemove(id),
    isPending: false,
  }),
}));

function renderModal(props?: Partial<React.ComponentProps<typeof ManageMembersModal>>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ManageMembersModal
        mapsetId="ms1"
        currentUserId="owner-id"
        isOwner
        onClose={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('ManageMembersModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPassphrase.mockReturnValue(null);
    membersData = [OWNER, MODDER];
  });

  it('lists members', () => {
    renderModal();
    expect(screen.getByText('OwnerUser')).toBeInTheDocument();
    expect(screen.getByText('ModderUser')).toBeInTheDocument();
  });

  it('owner can invite by username', async () => {
    renderModal();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Invite by osu! username/i), 'newuser');
    await user.click(screen.getByRole('button', { name: /^Invite$/i }));

    await waitFor(() => {
      expect(mockInvite).toHaveBeenCalledWith('newuser');
    });
  });

  it('owner can change a member role', async () => {
    renderModal();
    const user = userEvent.setup();
    const select = screen.getByLabelText(/Role/i, { selector: `#role-${MODDER.user_id}` });
    await user.selectOptions(select, 'mapper');
    await waitFor(() => {
      expect(mockUpdateRole).toHaveBeenCalledWith({ userId: MODDER.user_id, role: 'mapper' });
    });
  });

  it('owner can remove a non-self member', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderModal();
    const user = userEvent.setup();
    const removeButtons = screen.getAllByRole('button', { name: /Remove/i });
    await user.click(removeButtons[0]);
    await waitFor(() => {
      expect(mockRemove).toHaveBeenCalledWith(MODDER.user_id);
    });
  });

  it('hides invite form and role controls for non-owner', () => {
    renderModal({ isOwner: false, currentUserId: MODDER.user_id });
    expect(screen.queryByLabelText(/Invite by osu! username/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/i })).not.toBeInTheDocument();
  });

  it('shows passphrase when cached for owner', async () => {
    mockGetPassphrase.mockReturnValue('secret-passphrase-123');
    renderModal();
    const user = userEvent.setup();
    expect(screen.queryByText('secret-passphrase-123')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Show$/i }));
    expect(screen.getByText('secret-passphrase-123')).toBeInTheDocument();
  });

  it('blocks self-demotion with an inline error and no API call', async () => {
    renderModal();
    const select = screen.getByLabelText(/Role/i, {
      selector: `#role-${OWNER.user_id}`,
    }) as HTMLSelectElement;
    // The mapper option is rendered disabled to prevent picking it via the UI,
    // but the runtime guard is the actual safety net. Re-enable the option in
    // the DOM so we can drive the change event and exercise the guard at
    // ManageMembersModal.tsx:70-76 directly.
    const mapperOption = Array.from(select.options).find((o) => o.value === 'mapper');
    expect(mapperOption).toBeDefined();
    mapperOption!.disabled = false;

    fireEvent.change(select, { target: { value: 'mapper' } });

    expect(mockUpdateRole).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/cannot demote yourself/i),
    ).toBeInTheDocument();
  });

  it('owner can emulate a lower role and exit preview', async () => {
    const onEmulateRole = vi.fn();
    renderModal({ onEmulateRole, emulatedRole: null });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/Preview as role/i), 'mapper');
    expect(onEmulateRole).toHaveBeenCalledWith('mapper');

    onEmulateRole.mockClear();
    renderModal({ onEmulateRole, emulatedRole: 'mapper' });
    const previewSelects = screen.getAllByLabelText(/Preview as role/i);
    await user.selectOptions(previewSelects[previewSelects.length - 1], 'none');
    expect(onEmulateRole).toHaveBeenLastCalledWith(null);
  });

  it('hides the preview control for non-owners', () => {
    renderModal({ isOwner: false, currentUserId: MODDER.user_id, onEmulateRole: vi.fn() });
    expect(screen.queryByLabelText(/Preview as role/i)).not.toBeInTheDocument();
  });

  it('confirms ownership transfer before submitting', async () => {
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmMock);
    renderModal();
    const user = userEvent.setup();
    const select = screen.getByLabelText(/Role/i, { selector: `#role-${MODDER.user_id}` });
    await user.selectOptions(select, 'owner');
    expect(confirmMock).toHaveBeenCalled();
    expect(mockUpdateRole).not.toHaveBeenCalled();
  });
});
