import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { parseOszFile, type ParsedOsz } from '../utils/oszParser';
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
  const { t } = useTranslation();
  const { unlockWithKey } = useEncryption();
  const { showToast } = useToast();
  const createMapset = useCreateMapset();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [minutes, setMinutes] = useState('');
  const [seconds, setSeconds] = useState('');
  const [titleDirty, setTitleDirty] = useState(false);
  const [songLengthDirty, setSongLengthDirty] = useState(false);
  const [passphrase] = useState(() => generatePassphrase());
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [oszFile, setOszFile] = useState<File | null>(null);
  const [parsedOsz, setParsedOsz] = useState<ParsedOsz | null>(null);
  const [oszError, setOszError] = useState<string | null>(null);
  const [oszParsing, setOszParsing] = useState(false);

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

  async function handleOszFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setOszError(null);
    if (!f) {
      setOszFile(null);
      setParsedOsz(null);
      return;
    }
    setOszParsing(true);
    try {
      const result = await parseOszFile(f);
      if (result.difficulties.length === 0) {
        throw new Error(t('createMapsetModal.errorOszEmpty'));
      }
      setOszFile(f);
      setParsedOsz(result);
      if (!titleDirty) {
        const autoTitle =
          result.artist && result.title
            ? `${result.artist} - ${result.title}`
            : result.title || result.artist || '';
        if (autoTitle) setTitle(autoTitle);
      }
      if (!songLengthDirty && result.songLengthMs != null && result.songLengthMs > 0) {
        const totalSec = Math.round(result.songLengthMs / 1000);
        setMinutes(String(Math.floor(totalSec / 60)));
        setSeconds(String(totalSec % 60));
      }
    } catch (err) {
      setOszFile(null);
      setParsedOsz(null);
      setOszError(err instanceof Error ? err.message : t('createMapsetModal.errorOszGeneric'));
      e.target.value = '';
    } finally {
      setOszParsing(false);
    }
  }

  /**
   * After the mapset exists and the key is in memory, create all difficulties
   * extracted from the .osz, each with their bookmark-derived sections and
   * pre-populated .osu versions.
   *
   * INVARIANT: each difficulty is brand-new (just created in this submit),
   * so prepopulate=true is unconditionally safe here.
   */
  async function importDifficultiesFromOsz(
    key: CryptoKey,
    mapsetId: string,
    songLengthMs: number,
  ): Promise<string> {
    if (!parsedOsz || parsedOsz.difficulties.length === 0) return '';

    const summaries: string[] = [];
    let failedCount = 0;

    for (const diff of parsedOsz.difficulties) {
      const diffName = diff.name || diff.filename.replace(/\.osu$/i, '').trim() || 'Difficulty';
      const diffId = crypto.randomUUID();
      try {
        const encDiffName = await encrypt(key, diffName, difficultyFieldAad(diffId, mapsetId));
        await createDifficulty(mapsetId, { id: diffId, encrypted_name: encDiffName });

        const result = await importSectionsFromBookmarks({
          parsed: diff.parsed,
          key,
          mapsetId,
          difficultyId: diffId,
          songLengthMs: songLengthMs > 0 ? songLengthMs : null,
          prepopulate: true,
          startingSortOrder: 0,
        });

        if (result.total === 0) {
          summaries.push(t('createMapsetModal.diffNoSections', { name: diffName }));
        } else if (result.error) {
          summaries.push(t('createMapsetModal.diffPartial', { name: diffName, created: result.created, total: result.total }));
        } else {
          summaries.push(t('createMapsetModal.diffOk', { name: diffName, count: result.created }));
        }
      } catch (err) {
        failedCount++;
        summaries.push(
          t('createMapsetModal.diffFailed', { name: diffName, message: err instanceof Error ? err.message : t('createMapsetModal.unknownError') }),
        );
      }
    }

    const total = parsedOsz.difficulties.length;
    const ok = total - failedCount;
    const header =
      failedCount > 0
        ? t('createMapsetModal.importHeaderPartial', { ok, total })
        : t('createMapsetModal.importHeader', { count: total });
    return `${header}: ${summaries.join(', ')}.`;
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

      // If a .osz was uploaded, create all difficulties + sections.
      // A failure here is toasted as a warning but does not abort onSuccess
      // — the mapset itself exists.
      if (parsedOsz && parsedOsz.difficulties.length > 0) {
        try {
          const message = await importDifficultiesFromOsz(key, id, totalMs);
          if (message) showToast(message, 'success');
        } catch (err) {
          const msg = err instanceof Error ? err.message : t('createMapsetModal.importFailureGeneric');
          showToast(t('createMapsetModal.importFailure', { message: msg }), 'warning');
        }
      }

      onSuccess();
    } catch {
      setError(t('createMapsetModal.errorGeneric'));
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
          {t('createMapsetModal.title')}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="mapset-title" className="block text-sm font-medium text-gray-300 mb-1">
              {t('createMapsetModal.titleLabel')} <span className="text-red-400">{t('common.required')}</span>
            </label>
            <input
              id="mapset-title"
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); setTitleDirty(true); }}
              required
              maxLength={255}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              placeholder={t('createMapsetModal.titlePlaceholder')}
            />
            <p className="text-xs text-yellow-500 mt-1">
              {t('createMapsetModal.titleWarning')}
            </p>
          </div>

          <div>
            <label htmlFor="mapset-description" className="block text-sm font-medium text-gray-300 mb-1">
              {t('createMapsetModal.descriptionLabel')}
            </label>
            <textarea
              id="mapset-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 resize-none"
              placeholder={t('createMapsetModal.descriptionPlaceholder')}
            />
          </div>

          <div>
            <span className="block text-sm font-medium text-gray-300 mb-1">{t('createMapsetModal.songLengthLabel')}</span>
            <div className="flex gap-2">
              <div className="flex-1">
                <label htmlFor="mapset-song-minutes" className="sr-only">{t('createMapsetModal.minutes')}</label>
                <input
                  id="mapset-song-minutes"
                  type="number"
                  value={minutes}
                  onChange={makeClampedOnChange((v) => { setMinutes(v); setSongLengthDirty(true); })}
                  min={0}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                  placeholder="0"
                />
                <span className="text-xs text-gray-400 mt-1 block">{t('createMapsetModal.minutes')}</span>
              </div>
              <div className="flex-1">
                <label htmlFor="mapset-song-seconds" className="sr-only">{t('createMapsetModal.seconds')}</label>
                <input
                  id="mapset-song-seconds"
                  type="number"
                  value={seconds}
                  onChange={makeClampedOnChange((v) => { setSeconds(v); setSongLengthDirty(true); }, 59)}
                  min={0}
                  max={59}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                  placeholder="0"
                />
                <span className="text-xs text-gray-400 mt-1 block">{t('createMapsetModal.seconds')}</span>
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="mapset-osz" className="block text-sm font-medium text-gray-300 mb-1">
              {t('createMapsetModal.oszLabel')}
            </label>
            <input
              ref={fileInputRef}
              id="mapset-osz"
              type="file"
              accept=".osz,application/zip"
              onChange={handleOszFileChange}
              disabled={oszParsing}
              className="block w-full text-sm text-gray-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-purple-600 file:text-white hover:file:bg-purple-500 disabled:opacity-60"
            />
            <p className="text-xs text-gray-500 mt-1">
              {t('createMapsetModal.oszHelpPrefix')}<code>[Editor] Bookmarks</code>{t('createMapsetModal.oszHelpSuffix')}
            </p>
            {oszParsing && (
              <p className="text-xs text-blue-400 mt-1">{t('createMapsetModal.readingArchive')}</p>
            )}
            {oszFile && parsedOsz && !oszError && !oszParsing && (
              <div className="mt-2 space-y-1">
                <p className="text-xs text-green-400">
                  {t('createMapsetModal.foundDifficulties', { count: parsedOsz.difficulties.length })}
                </p>
                <ul className="text-xs text-gray-400 list-disc list-inside space-y-0.5">
                  {parsedOsz.difficulties.map((d) => (
                    <li key={d.filename}>{d.name ?? d.filename}</li>
                  ))}
                </ul>
              </div>
            )}
            {oszError && (
              <p role="alert" className="text-xs text-red-400 mt-1">{oszError}</p>
            )}
          </div>

          <div className="bg-gray-900 border border-gray-600 rounded p-4 space-y-3">
            <p className="text-sm font-medium text-gray-300">{t('createMapsetModal.passphraseLabel')}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-sm text-yellow-300 break-all select-all" aria-label={t('createMapsetModal.passphraseAria')}>
                {passphrase}
              </code>
              <button
                type="button"
                onClick={handleCopy}
                className="shrink-0 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
                aria-label={t('createMapsetModal.passphraseCopyAria')}
              >
                {copied ? t('common.copied') : t('common.copy')}
              </button>
            </div>
          </div>

          <div className="bg-red-950 border border-red-800 rounded p-3 text-sm text-red-300">
            <strong>{t('createMapsetModal.warningPrefix')}</strong>{t('createMapsetModal.warningBody')}
          </div>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 accent-blue-500"
              aria-label={t('createMapsetModal.confirmSavedAria')}
            />
            <span className="text-sm text-gray-300">
              {t('createMapsetModal.confirmSavedLabel')}
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
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={!title || !confirmed || submitting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded transition-colors"
            >
              {submitting ? t('createMapsetModal.submitting') : t('createMapsetModal.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
