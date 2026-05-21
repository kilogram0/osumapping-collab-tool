import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEncryption } from '../contexts/EncryptionContext';
import { encrypt, sectionFieldAad } from '../utils/crypto';
import { useUpdateSection } from '../hooks/useDifficulty';
import { formatTimestamp, parseTimestampString } from '../utils/extractTimestamp';

interface EditSectionModalProps {
  difficultyId: string;
  mapsetId: string;
  sectionId: string;
  initialName: string;
  initialStartTimeMs: number;
  initialEndTimeMs: number;
  /** End time of the section that follows this one, if any. Used to keep the
   *  next section at least MIN_SECTION_MS long. */
  nextSectionEndTimeMs?: number | null;
  /** Total song length in ms; the section's end time may not exceed this. */
  songLengthMs?: number | null;
  onSuccess: () => void;
  onCancel: () => void;
}

const MIN_SECTION_MS = 1000;

export default function EditSectionModal({
  difficultyId,
  mapsetId,
  sectionId,
  initialName,
  initialStartTimeMs,
  initialEndTimeMs,
  nextSectionEndTimeMs,
  songLengthMs,
  onSuccess,
  onCancel,
}: EditSectionModalProps) {
  const { t } = useTranslation();
  const { getKey } = useEncryption();
  const updateSection = useUpdateSection(difficultyId);

  const [name, setName] = useState(initialName);
  const [endTimeInput, setEndTimeInput] = useState(formatTimestamp(initialEndTimeMs));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setName(initialName);
    setEndTimeInput(formatTimestamp(initialEndTimeMs));
  }, [initialName, initialEndTimeMs]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    setSubmitting(true);

    try {
      const key = await getKey(mapsetId);
      if (!key) {
        setError(t('editSectionModal.errorKeyMissing'));
        setSubmitting(false);
        return;
      }

      const parsed = parseTimestampString(endTimeInput);
      if (!parsed) {
        setError(t('editSectionModal.errorInvalidFormat'));
        setSubmitting(false);
        return;
      }

      const endMs = parsed.ms;

      if (endMs < initialStartTimeMs + MIN_SECTION_MS) {
        setError(t('editSectionModal.errorTooEarly', { time: formatTimestamp(initialStartTimeMs) }));
        setSubmitting(false);
        return;
      }

      if (
        nextSectionEndTimeMs !== null &&
        nextSectionEndTimeMs !== undefined &&
        endMs > nextSectionEndTimeMs - MIN_SECTION_MS
      ) {
        setError(t('editSectionModal.errorPastNext', { time: formatTimestamp(nextSectionEndTimeMs) }));
        setSubmitting(false);
        return;
      }

      if (songLengthMs !== null && songLengthMs !== undefined && endMs > songLengthMs) {
        setError(t('editSectionModal.errorPastSong', { time: formatTimestamp(songLengthMs) }));
        setSubmitting(false);
        return;
      }

      const payload: Parameters<typeof updateSection.mutate>[0]['payload'] = {};

      payload.encrypted_name = await encrypt(key, name.trim(), sectionFieldAad(sectionId, mapsetId));
      payload.encrypted_end_time_ms = await encrypt(
        key,
        JSON.stringify({ v: 0, ms: endMs }),
        sectionFieldAad(sectionId, mapsetId),
      );

      await updateSection.mutateAsync({ sectionId, payload });

      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('editSectionModal.errorGeneric');
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-section-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-full max-w-md shadow-xl max-h-[90vh] overflow-y-auto">
        <h2 id="edit-section-title" className="text-xl font-bold text-white mb-4">
          {t('editSectionModal.title')}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="edit-section-name" className="block text-sm font-medium text-gray-300 mb-1">
              {t('editSectionModal.nameLabel')} <span className="text-red-400">{t('common.required')}</span>
            </label>
            <input
              id="edit-section-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={255}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <span className="block text-sm font-medium text-gray-300 mb-1">{t('editSectionModal.startTimeLabel')}</span>
            <p className="text-sm text-gray-400">
              {formatTimestamp(initialStartTimeMs)} <span className="text-xs text-gray-500">{t('editSectionModal.startTimeHint')}</span>
            </p>
          </div>

          <div>
            <label htmlFor="edit-section-end-time" className="block text-sm font-medium text-gray-300 mb-1">
              {t('editSectionModal.endTimeLabel')} <span className="text-red-400">{t('common.required')}</span>
            </label>
            <input
              id="edit-section-end-time"
              type="text"
              value={endTimeInput}
              onChange={(e) => setEndTimeInput(e.target.value)}
              required
              placeholder={t('editSectionModal.endTimePlaceholder')}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">{t('editSectionModal.endTimeFormatHint')}</p>
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
              disabled={!name.trim() || submitting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded transition-colors"
            >
              {submitting ? t('editSectionModal.submitting') : t('editSectionModal.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
