import { useState } from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import { useEncryption } from '../contexts/EncryptionContext';
import {
  useInviteMember,
  useMembers,
  useRemoveMember,
  useUpdateMemberRole,
} from '../hooks/useMapset';
import type { MapsetRole, MemberWithUser } from '../api/endpoints';

interface ManageMembersModalProps {
  mapsetId: string;
  currentUserId: string;
  isOwner: boolean;
  /** When the owner is previewing the page as a lower role; null otherwise. */
  emulatedRole?: MapsetRole | null;
  onEmulateRole?: (role: MapsetRole | null) => void;
  /** When the owner is previewing the page as a kicked ghost member. */
  emulateGhost?: boolean;
  onEmulateGhost?: (v: boolean) => void;
  onClose: () => void;
}

const ROLES: MapsetRole[] = ['owner', 'mapper', 'modder'];

const ROLE_LABEL_KEYS = {
  owner: 'manageMembers.roleOwner',
  mapper: 'manageMembers.roleMapper',
  modder: 'manageMembers.roleModder',
} as const satisfies Record<MapsetRole, string>;

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === 'string') return detail;
  }
  return fallback;
}

export default function ManageMembersModal({
  mapsetId,
  currentUserId,
  isOwner,
  emulatedRole = null,
  onEmulateRole,
  emulateGhost = false,
  onEmulateGhost,
  onClose,
}: ManageMembersModalProps) {
  const { t } = useTranslation();
  const { getPassphrase } = useEncryption();
  const { data: members, isLoading, isError } = useMembers(mapsetId);
  const inviteMutation = useInviteMember(mapsetId);
  const updateRoleMutation = useUpdateMemberRole(mapsetId);
  const removeMutation = useRemoveMember(mapsetId);

  const [username, setUsername] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [copied, setCopied] = useState(false);

  const cachedPassphrase = getPassphrase(mapsetId);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = username.trim();
    if (!trimmed) return;
    setInviteError(null);
    try {
      await inviteMutation.mutateAsync(trimmed);
      setUsername('');
    } catch (err) {
      setInviteError(errorMessage(err, t('manageMembers.errorInvite')));
    }
  }

  async function handleRoleChange(member: MemberWithUser, newRole: MapsetRole) {
    if (member.role === newRole) return;
    setMemberError(null);
    if (member.user_id === currentUserId && newRole !== 'owner') {
      setMemberError(t('manageMembers.errorDemoteSelf'));
      return;
    }
    if (newRole === 'owner') {
      if (!confirm(t('manageMembers.confirmTransfer', { username: member.username }))) {
        return;
      }
    }
    try {
      await updateRoleMutation.mutateAsync({ userId: member.user_id, role: newRole });
    } catch (err) {
      setMemberError(errorMessage(err, t('manageMembers.errorUpdateRole')));
    }
  }

  async function handleRemove(member: MemberWithUser) {
    setMemberError(null);
    if (!confirm(t('manageMembers.confirmRemove', { username: member.username }))) return;
    try {
      await removeMutation.mutateAsync(member.user_id);
    } catch (err) {
      setMemberError(errorMessage(err, t('manageMembers.errorRemove')));
    }
  }

  async function handleCopyPassphrase() {
    if (!cachedPassphrase) return;
    try {
      await navigator.clipboard.writeText(cachedPassphrase);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="manage-members-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    >
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-full max-w-lg shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 id="manage-members-title" className="text-xl font-bold text-white">
            {t('manageMembers.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('manageMembers.closeAria')}
            className="text-gray-400 hover:text-white"
          >
            ✕
          </button>
        </div>

        {isOwner && (
          <div className="bg-gray-900 border border-gray-600 rounded p-3 mb-4">
            <p className="text-sm font-medium text-gray-300 mb-2">{t('manageMembers.passphraseLabel')}</p>
            {cachedPassphrase ? (
              <>
                <div className="flex items-center gap-2">
                  <code
                    className="flex-1 font-mono text-sm text-yellow-300 break-all select-all"
                    aria-label={t('manageMembers.passphraseAria')}
                  >
                    {showPassphrase ? cachedPassphrase : '••••••••••••••••'}
                  </code>
                  <button
                    type="button"
                    onClick={() => setShowPassphrase((v) => !v)}
                    className="shrink-0 px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded"
                  >
                    {showPassphrase ? t('common.hide') : t('common.show')}
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyPassphrase}
                    className="shrink-0 px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded"
                  >
                    {copied ? t('common.copied') : t('common.copy')}
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  {t('manageMembers.shareHint')}
                </p>
              </>
            ) : (
              <p className="text-xs text-gray-400">
                {t('manageMembers.notCached')}
              </p>
            )}
          </div>
        )}

        {isOwner && (onEmulateRole || onEmulateGhost) && (
          <div className="bg-gray-900 border border-gray-600 rounded p-3 mb-4">
            <label htmlFor="emulate-role" className="block text-sm font-medium text-gray-300 mb-1">
              {t('manageMembers.previewLabel')}
            </label>
            <p className="text-xs text-gray-400 mb-2">
              {t('manageMembers.previewHint')}
            </p>
            <select
              id="emulate-role"
              value={emulateGhost ? 'ghost' : (emulatedRole ?? 'none')}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'ghost') {
                  onEmulateGhost?.(true);
                  onEmulateRole?.(null);
                } else {
                  onEmulateGhost?.(false);
                  onEmulateRole?.(val === 'none' ? null : (val as MapsetRole));
                }
              }}
              className="bg-gray-800 border border-gray-600 rounded text-white text-sm px-2 py-1"
            >
              <option value="none">{t('manageMembers.previewOwnerOption')}</option>
              <option value="mapper">{t('manageMembers.previewMapperOption')}</option>
              <option value="modder">{t('manageMembers.previewModderOption')}</option>
              <option value="ghost">{t('manageMembers.previewGhostOption')}</option>
            </select>
          </div>
        )}

        {isOwner && (
          <form onSubmit={handleInvite} className="mb-4 space-y-2">
            <label htmlFor="invite-username" className="block text-sm font-medium text-gray-300">
              {t('manageMembers.inviteLabel')}
            </label>
            <div className="flex gap-2">
              <input
                id="invite-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                maxLength={255}
                placeholder={t('manageMembers.invitePlaceholder')}
                className="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                disabled={!username.trim() || inviteMutation.isPending}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded text-sm font-medium"
              >
                {inviteMutation.isPending ? t('manageMembers.inviting') : t('manageMembers.invite')}
              </button>
            </div>
            {inviteError && (
              <p role="alert" className="text-red-400 text-sm">
                {inviteError}
              </p>
            )}
          </form>
        )}

        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-2">{t('manageMembers.membersHeading')}</h3>
          {isLoading && <p className="text-gray-400 text-sm">{t('manageMembers.membersLoading')}</p>}
          {isError && <p className="text-red-400 text-sm">{t('manageMembers.membersError')}</p>}
          {memberError && (
            <p role="alert" className="text-red-400 text-sm mb-2">
              {memberError}
            </p>
          )}
          <ul className="space-y-2">
            {members?.map((member) => {
              const isSelf = member.user_id === currentUserId;
              return (
                <li
                  key={member.id}
                  data-testid="member-row"
                  className="bg-gray-900 border border-gray-700 rounded p-3 flex items-center gap-3"
                >
                  <img
                    src={member.avatar_url}
                    alt=""
                    className="w-8 h-8 rounded-full bg-gray-700"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium truncate">
                      {member.username}
                      {isSelf && <span className="ml-1 text-gray-400 text-xs">{t('common.you')}</span>}
                    </p>
                    {!isOwner && (
                      <p className="text-xs text-gray-400">{t(ROLE_LABEL_KEYS[member.role])}</p>
                    )}
                  </div>
                  {isOwner && (
                    <div className="flex items-center gap-2">
                      <label className="sr-only" htmlFor={`role-${member.user_id}`}>
                        {t('manageMembers.roleSrLabel')}
                      </label>
                      <select
                        id={`role-${member.user_id}`}
                        value={member.role}
                        onChange={(e) =>
                          handleRoleChange(member, e.target.value as MapsetRole)
                        }
                        disabled={updateRoleMutation.isPending}
                        className="bg-gray-800 border border-gray-600 rounded text-white text-xs px-2 py-1"
                      >
                        {ROLES.map((role) => (
                          <option
                            key={role}
                            value={role}
                            disabled={isSelf && role !== 'owner'}
                          >
                            {t(ROLE_LABEL_KEYS[role])}
                          </option>
                        ))}
                      </select>
                      {!isSelf && (
                        <button
                          type="button"
                          onClick={() => handleRemove(member)}
                          disabled={removeMutation.isPending}
                          className="text-xs text-red-400 hover:text-red-300"
                        >
                          {t('manageMembers.remove')}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex justify-end pt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-gray-300 hover:text-white transition-colors"
          >
            {t('manageMembers.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
