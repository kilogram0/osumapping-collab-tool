import { useEffect, useState } from 'react';
import { useEncryption } from '../contexts/EncryptionContext';
import { useResources, useCreateResource, useDeleteResource } from '../hooks/useMapset';
import { encrypt, decrypt, mapsetResourceAad } from '../utils/crypto';
import { extractApiErrorMessage } from '../utils/errors';
import {
  ResourceIcon,
  RESOURCE_ICON_KEYS,
  RESOURCE_ICON_LABELS,
  DEFAULT_RESOURCE_ICON,
  type ResourceIconKey,
} from './resourceIcons';

interface DecryptedResource {
  id: string;
  name: string;
  url: string;
  /**
   * Decrypted icon key, or null when absent/undecryptable (renders default).
   * Deliberately `string` (not ResourceIconKey): the decrypted value is
   * untrusted, so normalization to a valid key is deferred to ResourceIcon.
   */
  icon: string | null;
  position: number;
}

interface Props {
  mapsetId: string;
  isOwner: boolean;
}

/**
 * Static, always-open card listing a mapset's encrypted resource links.
 *
 * Deliberately not a dropdown/accordion: it sits next to the difficulty
 * dropdown, so a trigger+chevron here would read as the same widget. A titled
 * list with per-item icons is a distinct affordance. Owner add/remove controls
 * live behind an "Edit" toggle to keep the read view clean.
 */
export default function ResourcesPanel({ mapsetId, isOwner }: Props) {
  const { data: rawResources } = useResources(mapsetId);
  const { isUnlocked, getKey } = useEncryption();
  const [decrypted, setDecrypted] = useState<DecryptedResource[]>([]);

  const createMutation = useCreateResource(mapsetId);
  const deleteMutation = useDeleteResource(mapsetId);

  const [editing, setEditing] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addIcon, setAddIcon] = useState<ResourceIconKey>(DEFAULT_RESOURCE_ICON);
  const [addError, setAddError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const unlocked = isUnlocked(mapsetId);

  useEffect(() => {
    if (!unlocked || !rawResources || rawResources.length === 0) {
      setDecrypted([]);
      return;
    }
    let cancelled = false;
    async function run() {
      const key = await getKey(mapsetId);
      if (!key || cancelled) return;
      const results: DecryptedResource[] = [];
      for (const r of rawResources!) {
        try {
          const aad = mapsetResourceAad(r.id, mapsetId);
          const name = await decrypt(key, r.encrypted_name, aad);
          const url = await decrypt(key, r.encrypted_url, aad);
          // Icon is best-effort: a failed/absent icon must not drop the row.
          let icon: string | null = null;
          if (r.encrypted_icon) {
            try {
              icon = await decrypt(key, r.encrypted_icon, aad);
            } catch {
              icon = null;
            }
          }
          results.push({ id: r.id, name, url, icon, position: r.position });
        } catch {
          // skip rows that fail to decrypt (wrong key, corruption)
        }
      }
      if (!cancelled) setDecrypted(results.sort((a, b) => a.position - b.position));
    }
    run();
    return () => { cancelled = true; };
  }, [rawResources, unlocked, mapsetId, getKey]);

  function resetAddForm() {
    setShowAddForm(false);
    setAddName('');
    setAddUrl('');
    setAddIcon(DEFAULT_RESOURCE_ICON);
    setAddError(null);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddError(null);
    const name = addName.trim();
    const url = addUrl.trim();
    if (!name) { setAddError('Name is required'); return; }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
    } catch {
      setAddError('URL must start with http:// or https://');
      return;
    }

    const key = await getKey(mapsetId);
    if (!key) { setAddError('Mapset is locked'); return; }

    const id = crypto.randomUUID();
    const aad = mapsetResourceAad(id, mapsetId);
    try {
      const encrypted_name = await encrypt(key, name, aad);
      const encrypted_url = await encrypt(key, url, aad);
      const encrypted_icon = await encrypt(key, addIcon, aad);
      await createMutation.mutateAsync({ id, encrypted_name, encrypted_url, encrypted_icon, position: 0 });
      resetAddForm();
    } catch (err) {
      setAddError(extractApiErrorMessage(err, 'Failed to add resource'));
    }
  }

  async function handleDelete(resourceId: string) {
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync(resourceId);
    } catch (err) {
      setDeleteError(extractApiErrorMessage(err, 'Failed to remove resource'));
    }
  }

  const hasResources = (rawResources?.length ?? 0) > 0;

  // Hide the card entirely for non-owners when there's nothing to show.
  // Only suppress once rawResources is defined (not during initial load).
  if (!isOwner && rawResources !== undefined && !hasResources) return null;

  return (
    <div className="mt-4 rounded-lg border border-gray-700 bg-gray-800/40">
      <div className="flex items-center justify-between px-4 py-3">
        <h3 className="text-sm font-semibold text-gray-200">
          Resources
          {hasResources && (
            <span className="ml-1.5 text-xs font-normal text-gray-400">({rawResources!.length})</span>
          )}
        </h3>
        {isOwner && unlocked && (
          <button
            type="button"
            onClick={() => { setEditing((v) => !v); resetAddForm(); }}
            aria-pressed={editing}
            className="text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
          >
            {editing ? 'Done' : 'Edit'}
          </button>
        )}
      </div>

      <div className="px-4 pb-3 space-y-3">
        {!unlocked && (
          <p className="text-sm text-gray-400 italic">Unlock this mapset to view resources.</p>
        )}

        {unlocked && decrypted.length > 0 && (
          <ul className="space-y-1.5">
            {decrypted.map((r) => (
              <li key={r.id} className="flex items-center gap-2.5">
                <span className="shrink-0 text-gray-400">
                  <ResourceIcon icon={r.icon} />
                </span>
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 min-w-0 truncate text-sm text-blue-400 hover:text-blue-300"
                >
                  {r.name}
                </a>
                {isOwner && editing && (
                  <button
                    type="button"
                    onClick={() => handleDelete(r.id)}
                    disabled={deleteMutation.isPending}
                    aria-label={`Remove resource ${r.name}`}
                    className="shrink-0 text-xs text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {unlocked && decrypted.length === 0 && (
          <p className="text-sm text-gray-400 italic">No resources yet.</p>
        )}

        {deleteError && <p className="text-xs text-red-400">{deleteError}</p>}

        {isOwner && unlocked && editing && (
          <div>
            {!showAddForm ? (
              <button
                type="button"
                onClick={() => setShowAddForm(true)}
                className="text-sm text-blue-500 hover:text-blue-400 transition-colors"
              >
                + Add resource
              </button>
            ) : (
              <form onSubmit={handleAdd} className="space-y-2 mt-1">
                <input
                  type="text"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  placeholder="Name (e.g. .osz download)"
                  className="w-full px-3 py-1.5 bg-gray-800 border border-gray-600 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                <input
                  type="text"
                  value={addUrl}
                  onChange={(e) => setAddUrl(e.target.value)}
                  placeholder="URL (https://...)"
                  className="w-full px-3 py-1.5 bg-gray-800 border border-gray-600 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                <div>
                  <p className="text-xs text-gray-400 mb-1">Icon</p>
                  <div className="flex flex-wrap gap-1.5">
                    {RESOURCE_ICON_KEYS.map((key) => {
                      const selected = addIcon === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setAddIcon(key)}
                          aria-label={RESOURCE_ICON_LABELS[key]}
                          title={RESOURCE_ICON_LABELS[key]}
                          aria-pressed={selected}
                          className={`p-1.5 rounded border transition-colors ${
                            selected
                              ? 'border-blue-500 bg-blue-600/20 text-white'
                              : 'border-gray-600 text-gray-400 hover:text-white hover:border-gray-500'
                          }`}
                        >
                          <ResourceIcon icon={key} />
                        </button>
                      );
                    })}
                  </div>
                </div>
                {addError && <p className="text-xs text-red-400">{addError}</p>}
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={createMutation.isPending}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded transition-colors"
                  >
                    {createMutation.isPending ? 'Adding…' : 'Add'}
                  </button>
                  <button
                    type="button"
                    onClick={resetAddForm}
                    className="px-3 py-1.5 text-gray-400 hover:text-gray-200 text-sm transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
