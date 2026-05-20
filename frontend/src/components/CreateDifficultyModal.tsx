import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useEncryption } from '../contexts/EncryptionContext';
import { useToast } from '../contexts/ToastContext';
import { encrypt, difficultyFieldAad } from '../utils/crypto';
import { useCreateDifficulty } from '../hooks/useDifficulty';
import {
  parseOsuFile,
  parseDifficultyName,
  MAX_OSU_BYTES,
  type ParsedOsuFile,
} from '../utils/osuParser';
import { importSectionsFromBookmarks } from '../utils/importSectionsFromBookmarks';

interface CreateDifficultyModalProps {
  mapsetId: string;
  songLengthMs?: number | null;
  onSuccess: (newDifficultyId: string) => void;
  onCancel: () => void;
}

export default function CreateDifficultyModal({
  mapsetId,
  songLengthMs,
  onSuccess,
  onCancel,
}: CreateDifficultyModalProps) {
  const { getKey } = useEncryption();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const createDifficulty = useCreateDifficulty(mapsetId);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [osuFile, setOsuFile] = useState<File | null>(null);
  // Cache the parsed file from handleFileChange so importBookmarks doesn't
  // have to re-read + re-parse on submit.
  const [parsedOsu, setParsedOsu] = useState<ParsedOsuFile | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setParseError(null);
    if (!f) {
      setOsuFile(null);
      setParsedOsu(null);
      return;
    }
    if (f.size > MAX_OSU_BYTES) {
      setOsuFile(null);
      setParsedOsu(null);
      setParseError(`File too large (${f.size} bytes; max ${MAX_OSU_BYTES}).`);
      e.target.value = '';
      return;
    }
    // Eager-validate so the user sees the size/format problem before submit.
    try {
      const text = await f.text();
      const parsed = parseOsuFile(text);
      setOsuFile(f);
      setParsedOsu(parsed);
      // If the user hasn't typed a name yet, derive one from the .osu's
      // [Metadata] Version field. Don't overwrite an explicit name.
      const derived = parseDifficultyName(parsed);
      if (derived && !name.trim()) {
        setName(derived);
      }
    } catch (err) {
      setOsuFile(null);
      setParsedOsu(null);
      setParseError(err instanceof Error ? err.message : 'Invalid .osu file.');
      e.target.value = '';
    }
  }

  /** Delegates to the shared {@link importSectionsFromBookmarks} helper.
   *  Brand-new difficulty in this submit → no base history → prepopulate=true
   *  is unconditionally safe. */
  async function importBookmarks(
    key: CryptoKey,
    difficultyId: string,
  ): Promise<{ created: number; total: number; error: string | null }> {
    if (!parsedOsu) return { created: 0, total: 0, error: null };
    return importSectionsFromBookmarks({
      parsed: parsedOsu,
      key,
      mapsetId,
      difficultyId,
      songLengthMs: songLengthMs ?? null,
      prepopulate: true,
      startingSortOrder: 0,
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    setSubmitting(true);

    let newDifficultyId: string | null = null;
    try {
      const key = await getKey(mapsetId);
      if (!key) {
        setError('Encryption key not found. Please unlock the mapset first.');
        setSubmitting(false);
        return;
      }

      const id = crypto.randomUUID();
      const encryptedName = await encrypt(key, name.trim(), difficultyFieldAad(id, mapsetId));

      await createDifficulty.mutateAsync({
        id,
        encrypted_name: encryptedName,
      });
      newDifficultyId = id;

      // Difficulty creation succeeded. If a .osu file is attached, run the
      // bookmark import against the new difficulty. Failures here are toasted
      // but do not roll back the difficulty (the user can retry via the
      // standalone Import Bookmarks button afterwards).
      if (osuFile) {
        const result = await importBookmarks(key, id);
        if (result.error) {
          if (result.created > 0) {
            // Partial success: a base version + some sections were created,
            // so the next Import Bookmarks click on this difficulty will skip
            // pre-population (history is no longer empty). Heads-up the user
            // so they know retrying won't fill the rest with .osu content.
            showToast(
              `Difficulty created. Imported ${result.created} of ${result.total} sections before failing: ${result.error}. Re-running Import Bookmarks will create the remaining sections but won't pre-fill their content (base history now exists).`,
              'warning',
            );
          } else {
            showToast(`Difficulty created, but bookmark import failed: ${result.error}`, 'warning');
          }
        } else {
          showToast(`Difficulty created with ${result.created} imported section${result.created === 1 ? '' : 's'}.`, 'success');
        }
        queryClient.invalidateQueries({ queryKey: ['sections', id] });
        queryClient.invalidateQueries({ queryKey: ['difficulty-detail', id] });
      } else {
        showToast('Difficulty created.', 'success');
      }

      onSuccess(newDifficultyId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create difficulty';
      if (newDifficultyId) {
        // Should not happen — only the difficulty mutation path throws here,
        // and we set newDifficultyId only after it resolves. But surface it
        // explicitly if it ever does.
        showToast(`Difficulty created, but a follow-up step failed: ${message}`, 'warning');
        onSuccess(newDifficultyId);
      } else {
        setError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-difficulty-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-full max-w-md shadow-xl">
        <h2 id="create-difficulty-title" className="text-xl font-bold text-white mb-4">
          Add Difficulty
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="difficulty-name" className="block text-sm font-medium text-gray-300 mb-1">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              id="difficulty-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={255}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              placeholder="e.g. Hard"
            />
          </div>

          <div>
            <label htmlFor="difficulty-osu" className="block text-sm font-medium text-gray-300 mb-1">
              Optionally import sections from .osu bookmarks
            </label>
            <input
              ref={fileInputRef}
              id="difficulty-osu"
              type="file"
              accept=".osu"
              onChange={handleFileChange}
              className="block w-full text-sm text-gray-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-purple-600 file:text-white hover:file:bg-purple-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              Reads <code>[Editor] Bookmarks</code> client-side. Max 1 MB; the file itself is not uploaded.
            </p>
            {osuFile && !parseError && (
              <p className="text-xs text-green-400 mt-1">Selected: {osuFile.name}</p>
            )}
            {parseError && (
              <p role="alert" className="text-xs text-red-400 mt-1">{parseError}</p>
            )}
          </div>

          {error && (
            <p role="alert" className="text-red-400 text-sm">
              {error}
            </p>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-gray-300 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || submitting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded transition-colors"
            >
              {submitting ? 'Creating…' : 'Add Difficulty'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
