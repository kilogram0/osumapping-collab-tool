import { useEffect, useState } from 'react';
import { useEncryption } from '../contexts/EncryptionContext';
import { useResources, useCreateResource, useDeleteResource } from '../hooks/useMapset';
import { encrypt, decrypt, mapsetResourceAad } from '../utils/crypto';
import { extractApiErrorMessage } from '../utils/errors';

interface DecryptedResource {
  id: string;
  name: string;
  url: string;
  position: number;
}

interface Props {
  mapsetId: string;
  isOwner: boolean;
}

export default function ResourcesPanel({ mapsetId, isOwner }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const { data: rawResources } = useResources(mapsetId);
  const { isUnlocked, getKey } = useEncryption();
  const [decrypted, setDecrypted] = useState<DecryptedResource[]>([]);

  const createMutation = useCreateResource(mapsetId);
  const deleteMutation = useDeleteResource(mapsetId);

  const [addName, setAddName] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

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
          results.push({ id: r.id, name, url, position: r.position });
        } catch {
          // skip rows that fail to decrypt (wrong key, corruption)
        }
      }
      if (!cancelled) setDecrypted(results.sort((a, b) => a.position - b.position));
    }
    run();
    return () => { cancelled = true; };
  }, [rawResources, unlocked, mapsetId, getKey]);

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
      await createMutation.mutateAsync({ id, encrypted_name, encrypted_url, position: 0 });
      setAddName('');
      setAddUrl('');
      setShowAddForm(false);
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

  // Hide the panel entirely for non-owners when there's nothing to show.
  // Only suppress once rawResources is defined (not during initial load).
  if (!isOwner && rawResources !== undefined && !hasResources) return null;

  return (
    <div className="mt-4 border border-gray-700 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-800 hover:bg-gray-750 text-left transition-colors"
        aria-expanded={isOpen}
      >
        <span className="text-sm font-semibold text-gray-200">
          Resources
          {hasResources && (
            <span className="ml-2 text-xs text-gray-400">({rawResources!.length})</span>
          )}
        </span>
        <span className="text-gray-400 text-xs">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div className="px-4 py-3 bg-gray-900 space-y-3">
          {!unlocked && (
            <p className="text-sm text-gray-400 italic">Unlock this mapset to view resources.</p>
          )}

          {unlocked && decrypted.length === 0 && !isOwner && (
            <p className="text-sm text-gray-400 italic">No resources have been added yet.</p>
          )}

          {unlocked && decrypted.length > 0 && (
            <ul className="space-y-2">
              {decrypted.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-400 hover:text-blue-300 underline truncate"
                  >
                    {r.name}
                  </a>
                  {isOwner && (
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

          {deleteError && (
            <p className="text-xs text-red-400">{deleteError}</p>
          )}

          {isOwner && unlocked && (
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
                <form onSubmit={handleAdd} className="space-y-2 mt-2">
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
                  {addError && (
                    <p className="text-xs text-red-400">{addError}</p>
                  )}
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
                      onClick={() => { setShowAddForm(false); setAddName(''); setAddUrl(''); setAddError(null); }}
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
      )}
    </div>
  );
}
