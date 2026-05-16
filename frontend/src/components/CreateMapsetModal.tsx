import { useEffect, useState } from 'react';
import { useEncryption } from '../contexts/EncryptionContext';
import { encrypt, generatePassphrase, generateSalt, mapsetFieldAad, mapsetVerificationAad, VERIFICATION_CANARY, deriveKey } from '../utils/crypto';
import { useCreateMapset } from '../hooks/useMapset';

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
  const createMapset = useCreateMapset();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [minutes, setMinutes] = useState('');
  const [seconds, setSeconds] = useState('');
  const [passphrase] = useState(() => generatePassphrase());
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      await unlockWithKey(id, key);
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
