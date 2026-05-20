import { useEffect, useRef, useState } from 'react';
import { useEncryption } from '../contexts/EncryptionContext';
import { useToast } from '../contexts/ToastContext';
import {
  encrypt,
  generatePassphrase,
  generateSalt,
  mapsetFieldAad,
  mapsetVerificationAad,
  difficultyFieldAad,
  VERIFICATION_CANARY,
  deriveKey,
} from '../utils/crypto';
import { useCreateMapset } from '../hooks/useMapset';
import { createDifficulty } from '../api/endpoints';
import {
  parseOsuFile,
  parseDifficultyName,
  parseMetadata,
  MAX_OSU_BYTES,
  type ParsedOsuFile,
} from '../utils/osuParser';
import { importSectionsFromBookmarks } from '../utils/importSectionsFromBookmarks';

interface CreateMapsetModalProps {
  onSuccess: () => void;
  onCancel: () => void;
}

/** Build an onChange handler that clamps numeric input to [0, max].
 *  max === undefined means no upper bound (e.g. minutes). */
function makeClampedOnChange(
  setter: (v: string) => void,
  max?: number,
): (e: React.ChangeEvent<HTMLInputElement>) => void {
  return (e) => {
    const raw = e.target.value;
    if (raw === '') {
      setter('');
      return;
    }
    // Note: parseInt silently truncates scientific notation ("1e3" → 1).
    // Native <input type="number"> validation blocks most malformed input,
    // so this edge case is accepted rather than adding regex overhead.
    let val = parseInt(raw, 10);
    if (Number.isNaN(val) || val < 0) val = 0;
    if (max !== undefined && val > max) val = max;
    setter(String(val));
  };
}

export default function CreateMapsetModal({ onSuccess, onCancel }: CreateMapsetModalProps) {
  const { unlockWithKey } = useEncryption();
  const { showToast } = useToast();
  const createMapset = useCreateMapset();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [minutes, setMinutes] = useState('');
  const [seconds, setSeconds] = useState('');
  const [passphrase] = useState(() => generatePassphrase());
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [osuFile, setOsuFile] = useState<File | null>(null);
  const [parsedOsu, setParsedOsu] = useState<ParsedOsuFile | null>(null);
  const [osuFileError, setOsuFileError] = useState<string | null>(null);

  useEffect(() => {
    if (copied) {
      const t = setTimeout(() => setCopied(false), 2000);
      return () => clearTimeout(t);
    }
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(passphrase);
      setCopied(true);
    } catch {
      // Clipboard access denied (e.g. Firefox without focus); no-op.
    }
  }

  async function handleOsuFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setOsuFileError(null);
    if (!f) {
      setOsuFile(null);
      setParsedOsu(null);
      return;
    }
    if (f.size > MAX_OSU_BYTES) {
      setOsuFile(null);
      setParsedOsu(null);
      setOsuFileError(`File too large (${f.size} bytes; max ${MAX_OSU_BYTES}).`);
      e.target.value = '';
      return;
    }
    try {
      const text = await f.text();
      const parsed = parseOsuFile(text);
      setOsuFile(f);
      setParsedOsu(parsed);
      // Auto-fill title from [Metadata] Title if the user hasn't typed one.
      if (!title.trim()) {
        const derivedTitle = parseMetadata(parsed).title;
        if (derivedTitle) setTitle(derivedTitle);
      }
    } catch (err) {
      setOsuFile(null);
      setParsedOsu(null);
      setOsuFileError(err instanceof Error ? err.message : 'Invalid .osu file.');
      e.target.value = '';
    }
  }

  /**
   * After the mapset exists and the key is in memory, create a first
   * difficulty from the attached .osu plus its bookmark-derived sections
   * and pre-populated section .osu versions.
   *
   * INVARIANT: this runs only after `createDifficulty` succeeds in this same
   * submit, so the difficulty has zero base history → prepopulate=true is
   * unconditionally safe. (The standalone Import Bookmarks button handles
   * the "existing difficulty, maybe has history" case with a separate check;
   * do not copy this assumption into a context where the difficulty already
   * existed before the import was requested.)
   *
   * Returns a status string for toast display.
   */
  async function importFirstDifficulty(
    key: CryptoKey,
    mapsetId: string,
    songLengthMs: number,
  ): Promise<string> {
    if (!parsedOsu || !osuFile) return '';

    const fallbackName =
      osuFile.name.replace(/\.osu$/i, '').trim() || 'Difficulty';
    const diffName = parseDifficultyName(parsedOsu) || fallbackName;
    const diffId = crypto.randomUUID();
    const encDiffName = await encrypt(key, diffName, difficultyFieldAad(diffId, mapsetId));
    await createDifficulty(mapsetId, { id: diffId, encrypted_name: encDiffName });

    const result = await importSectionsFromBookmarks({
      parsed: parsedOsu,
      key,
      mapsetId,
      difficultyId: diffId,
      songLengthMs: songLengthMs > 0 ? songLengthMs : null,
      prepopulate: true,
      startingSortOrder: 0,
    });

    if (result.total === 0) {
      // No bookmarks (or no derivable boundaries). Difficulty exists, no
      // sections — the difficulty is still usable, user can add sections later.
      return `Mapset created with difficulty "${diffName}". (${result.error ?? 'No sections imported.'})`;
    }
    if (result.error) {
      // Partial failure: difficulty + base + some sections exist. The user
      // is on a path where re-running the standalone Import Bookmarks button
      // on the new diff won't pre-populate (base history is no longer empty).
      return `Mapset created with difficulty "${diffName}". Imported ${result.created} of ${result.total} sections before failing: ${result.error}. Re-running Import Bookmarks on this difficulty will add the missing sections but won't pre-fill their content.`;
    }
    return `Mapset created with difficulty "${diffName}" (${result.created} section${result.created === 1 ? '' : 's'} imported).`;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    setError(null);
    setSubmitting(true);

    try {
      const id = crypto.randomUUID();
      const salt = generateSalt();
      const key = await deriveKey(passphrase, salt);

      const totalMs = (Number(minutes) || 0) * 60_000 + (Number(seconds) || 0) * 1_000;

      // Versioned JSON envelope makes the ciphertext self-describing.
      // Future readers can distinguish v1 ({"v":1,"ms":…}) from older raw strings.
      const songLengthPayload = JSON.stringify({ v: 1, ms: totalMs });

      const [encryptedDescription, encryptedSongLengthMs, encryptedVerification] =
        await Promise.all([
          description ? encrypt(key, description, mapsetFieldAad(id)) : Promise.resolve(null),
          encrypt(key, songLengthPayload, mapsetFieldAad(id)),
          encrypt(key, VERIFICATION_CANARY, mapsetVerificationAad(id)),
        ]);

      await createMapset.mutateAsync({
        id,
        title,
        encrypted_description: encryptedDescription,
        encrypted_song_length_ms: encryptedSongLengthMs,
        passphrase_salt: salt,
        encrypted_verification: encryptedVerification,
      });

      // Re-use the already-derived key — avoids a second 600k-iteration PBKDF2 run.
      // Cache the passphrase in memory so the owner can re-view it from the Manage Members modal.
      await unlockWithKey(id, key, passphrase);

      // If a .osu file was attached, create the first difficulty + sections +
      // pre-populated section versions. A failure here is toasted as a
      // warning but does not abort onSuccess — the mapset itself exists.
      if (parsedOsu && osuFile) {
        try {
          const message = await importFirstDifficulty(key, id, totalMs);
          if (message) showToast(message, 'success');
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to import first difficulty.';
          showToast(`Mapset created, but first-difficulty import failed: ${msg}`, 'warning');
        }
      }

      onSuccess();
    } catch {
      setError('Failed to create mapset. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-mapset-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    >
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-full max-w-lg shadow-xl max-h-[90vh] overflow-y-auto">
        <h2 id="create-mapset-modal-title" className="text-xl font-bold text-white mb-4">
          Create Mapset
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="mapset-title" className="block text-sm font-medium text-gray-300 mb-1">
              Title <span className="text-red-400">*</span>
            </label>
            <input
              id="mapset-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={255}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              placeholder="Mapset title"
            />
            <p className="text-xs text-yellow-500 mt-1">
              The title will be visible to anyone who sees the invitation link or has database access. It is not encrypted — do not include private information.
            </p>
          </div>

          <div>
            <label htmlFor="mapset-description" className="block text-sm font-medium text-gray-300 mb-1">
              Description
            </label>
            <textarea
              id="mapset-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 resize-none"
              placeholder="Optional description"
            />
          </div>

          <div>
            <span className="block text-sm font-medium text-gray-300 mb-1">Song Length</span>
            <div className="flex gap-2">
              <div className="flex-1">
                <label htmlFor="mapset-song-minutes" className="sr-only">Minutes</label>
                <input
                  id="mapset-song-minutes"
                  type="number"
                  value={minutes}
                  onChange={makeClampedOnChange(setMinutes)}
                  min={0}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                  placeholder="0"
                />
                <span className="text-xs text-gray-400 mt-1 block">Minutes</span>
              </div>
              <div className="flex-1">
                <label htmlFor="mapset-song-seconds" className="sr-only">Seconds</label>
                <input
                  id="mapset-song-seconds"
                  type="number"
                  value={seconds}
                  onChange={makeClampedOnChange(setSeconds, 59)}
                  min={0}
                  max={59}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                  placeholder="0"
                />
                <span className="text-xs text-gray-400 mt-1 block">Seconds</span>
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="mapset-osu" className="block text-sm font-medium text-gray-300 mb-1">
              Optionally start from a .osu file
            </label>
            <input
              ref={fileInputRef}
              id="mapset-osu"
              type="file"
              accept=".osu"
              onChange={handleOsuFileChange}
              className="block w-full text-sm text-gray-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-purple-600 file:text-white hover:file:bg-purple-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              Creates a first difficulty (name from <code>[Metadata] Version</code>), plus sections from <code>[Editor] Bookmarks</code> with their first .osu versions pre-populated. Max 1 MB; not uploaded raw.
            </p>
            {osuFile && !osuFileError && (
              <p className="text-xs text-green-400 mt-1">Selected: {osuFile.name}</p>
            )}
            {osuFileError && (
              <p role="alert" className="text-xs text-red-400 mt-1">{osuFileError}</p>
            )}
          </div>

          <div className="bg-gray-900 border border-gray-600 rounded p-4 space-y-3">
            <p className="text-sm font-medium text-gray-300">Your Passphrase</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-sm text-yellow-300 break-all select-all" aria-label="Generated passphrase">
                {passphrase}
              </code>
              <button
                type="button"
                onClick={handleCopy}
                className="shrink-0 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
                aria-label="Copy passphrase to clipboard"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="bg-red-950 border border-red-800 rounded p-3 text-sm text-red-300">
            <strong>Warning:</strong> If you lose this passphrase and no other member has it, all mapset data is permanently unrecoverable. There is no server-side recovery.
          </div>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 accent-blue-500"
              aria-label="I have saved this passphrase"
            />
            <span className="text-sm text-gray-300">
              I have saved this passphrase in a secure location.
            </span>
          </label>

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
              disabled={!title || !confirmed || submitting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded transition-colors"
            >
              {submitting ? 'Creating…' : 'Create Mapset'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
