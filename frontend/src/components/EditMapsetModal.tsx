import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEncryption } from '../contexts/EncryptionContext';
import { useToast } from '../contexts/ToastContext';
import { encrypt, mapsetFieldAad } from '../utils/crypto';
import { makeClampedOnChange } from '../utils/numericInput';
import { useUpdateMapset } from '../hooks/useMapset';
import type { UpdateMapsetPayload } from '../api/endpoints';

interface EditMapsetModalProps {
  mapsetId: string;
  /** Title is stored plaintext, so it arrives already readable. */
  currentTitle: string;
  /** Decrypted description, or null when none is set. */
  currentDescription: string | null;
  /** Decrypted song length in ms, or null when unknown. */
  currentSongLengthMs: number | null;
  onSuccess: () => void;
  onCancel: () => void;
}

export default function EditMapsetModal({
  mapsetId,
  currentTitle,
  currentDescription,
  currentSongLengthMs,
  onSuccess,
  onCancel,
}: EditMapsetModalProps) {
  const { t } = useTranslation();
  const { getKey } = useEncryption();
  const { showToast } = useToast();
  const updateMapset = useUpdateMapset(mapsetId);

  const [title, setTitle] = useState(currentTitle);
  const [description, setDescription] = useState(currentDescription ?? '');
  const [minutes, setMinutes] = useState(
    currentSongLengthMs != null ? String(Math.floor(currentSongLengthMs / 1000 / 60)) : '',
  );
  const [seconds, setSeconds] = useState(
    currentSongLengthMs != null ? String(Math.floor(currentSongLengthMs / 1000) % 60) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    setError(null);
    setSubmitting(true);

    try {
      const key = await getKey(mapsetId);
      if (!key) {
        setError(t('editMapsetModal.errorKeyMissing'));
        setSubmitting(false);
        return;
      }

      const trimmedDescription = description.trim();
      // Treat both inputs blank as "leave song length unchanged" rather than
      // writing {ms:0} — otherwise saving an untouched length-less mapset would
      // persist a spurious 00:00. An explicit 0 in either field still counts.
      const hasSongLength = minutes !== '' || seconds !== '';

      const aad = mapsetFieldAad(mapsetId);
      const [encryptedDescription, encryptedSongLengthMs] = await Promise.all([
        trimmedDescription ? encrypt(key, trimmedDescription, aad) : Promise.resolve(null),
        hasSongLength
          ? encrypt(
              key,
              // Versioned JSON envelope keeps the ciphertext self-describing
              // (matches CreateMapsetModal: {"v":1,"ms":…}).
              JSON.stringify({ v: 1, ms: (Number(minutes) || 0) * 60_000 + (Number(seconds) || 0) * 1_000 }),
              aad,
            )
          : Promise.resolve(null),
      ]);

      // PATCH treats an explicit null description as "clear it", which is
      // exactly what an emptied field should do. Song length is omitted
      // entirely when blank so an untouched value is left unchanged.
      const payload: UpdateMapsetPayload = {
        title: trimmedTitle,
        encrypted_description: encryptedDescription,
      };
      if (encryptedSongLengthMs !== null) {
        payload.encrypted_song_length_ms = encryptedSongLengthMs;
      }
      await updateMapset.mutateAsync(payload);

      showToast(t('editMapsetModal.toastUpdated'), 'success');
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('editMapsetModal.errorGeneric'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-mapset-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-full max-w-lg shadow-xl max-h-[90vh] overflow-y-auto">
        <h2 id="edit-mapset-title" className="text-xl font-bold text-white mb-4">
          {t('editMapsetModal.title')}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="edit-mapset-title-input" className="block text-sm font-medium text-gray-300 mb-1">
              {t('editMapsetModal.titleLabel')} <span className="text-red-400">{t('common.required')}</span>
            </label>
            <input
              id="edit-mapset-title-input"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={255}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              placeholder={t('editMapsetModal.titlePlaceholder')}
              autoFocus
            />
            <p className="text-xs text-yellow-500 mt-1">
              {t('editMapsetModal.titleWarning')}
            </p>
          </div>

          <div>
            <label htmlFor="edit-mapset-description" className="block text-sm font-medium text-gray-300 mb-1">
              {t('editMapsetModal.descriptionLabel')}
            </label>
            <textarea
              id="edit-mapset-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 resize-none"
              placeholder={t('editMapsetModal.descriptionPlaceholder')}
            />
          </div>

          <div>
            <span className="block text-sm font-medium text-gray-300 mb-1">{t('editMapsetModal.songLengthLabel')}</span>
            <div className="flex gap-2">
              <div className="flex-1">
                <label htmlFor="edit-mapset-song-minutes" className="sr-only">{t('editMapsetModal.minutes')}</label>
                <input
                  id="edit-mapset-song-minutes"
                  type="number"
                  value={minutes}
                  onChange={makeClampedOnChange(setMinutes)}
                  min={0}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                  placeholder="0"
                />
                <span className="text-xs text-gray-400 mt-1 block">{t('editMapsetModal.minutes')}</span>
              </div>
              <div className="flex-1">
                <label htmlFor="edit-mapset-song-seconds" className="sr-only">{t('editMapsetModal.seconds')}</label>
                <input
                  id="edit-mapset-song-seconds"
                  type="number"
                  value={seconds}
                  onChange={makeClampedOnChange(setSeconds, 59)}
                  min={0}
                  max={59}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                  placeholder="0"
                />
                <span className="text-xs text-gray-400 mt-1 block">{t('editMapsetModal.seconds')}</span>
              </div>
            </div>
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
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={!title.trim() || submitting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded transition-colors"
            >
              {submitting ? t('editMapsetModal.submitting') : t('editMapsetModal.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
