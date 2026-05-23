import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatTimestamp, parseTimestampString } from '../utils/extractTimestamp';
import type { DecryptedSection } from './SectionList';

interface SplitSectionModalProps {
  section: DecryptedSection;
  onSubmit: (params: { newSectionName: string; splitTimeMs: number }) => void | Promise<void>;
  onCancel: () => void;
  submitting?: boolean;
  externalError?: string | null;
}

const MIN_SECTION_MS = 1000;

export default function SplitSectionModal({
  section,
  onSubmit,
  onCancel,
  submitting = false,
  externalError = null,
}: SplitSectionModalProps) {
  const { t } = useTranslation();
  const [newSectionName, setNewSectionName] = useState('');
  const [splitTimeInput, setSplitTimeInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const displayedError = error ?? externalError;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!newSectionName.trim()) return;
    setError(null);

    const parsed = parseTimestampString(splitTimeInput);
    if (!parsed) {
      setError(t('splitSectionModal.errorInvalidFormat'));
      return;
    }

    const splitMs = parsed.ms;

    if (splitMs < section.startTimeMs + MIN_SECTION_MS) {
      setError(t('splitSectionModal.errorTooEarly', { min: formatTimestamp(section.startTimeMs + MIN_SECTION_MS) }));
      return;
    }

    if (splitMs > section.endTimeMs - MIN_SECTION_MS) {
      setError(t('splitSectionModal.errorTooLate', { max: formatTimestamp(section.endTimeMs - MIN_SECTION_MS) }));
      return;
    }

    void onSubmit({ newSectionName: newSectionName.trim(), splitTimeMs: splitMs });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="split-section-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-full max-w-md shadow-xl max-h-[90vh] overflow-y-auto">
        <h2 id="split-section-title" className="text-xl font-bold text-white mb-4">
          {t('splitSectionModal.title')}
        </h2>

        <p className="text-sm text-gray-400 mb-4">
          {t('splitSectionModal.rangeHint', {
            start: formatTimestamp(section.startTimeMs),
            end: formatTimestamp(section.endTimeMs),
          })}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="split-time" className="block text-sm font-medium text-gray-300 mb-1">
              {t('splitSectionModal.splitTimeLabel')} <span className="text-red-400">{t('common.required')}</span>
            </label>
            <input
              id="split-time"
              type="text"
              value={splitTimeInput}
              onChange={(e) => setSplitTimeInput(e.target.value)}
              required
              placeholder={t('splitSectionModal.splitTimePlaceholder')}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">{t('splitSectionModal.splitTimeFormatHint')}</p>
          </div>

          <div>
            <label htmlFor="new-section-name" className="block text-sm font-medium text-gray-300 mb-1">
              {t('splitSectionModal.newSectionNameLabel')} <span className="text-red-400">{t('common.required')}</span>
            </label>
            <input
              id="new-section-name"
              type="text"
              value={newSectionName}
              onChange={(e) => setNewSectionName(e.target.value)}
              required
              maxLength={255}
              placeholder={t('splitSectionModal.newSectionNamePlaceholder')}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          {displayedError && (
            <p role="alert" className="text-red-400 text-sm">
              {displayedError}
            </p>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="px-4 py-2 text-gray-300 hover:text-white transition-colors disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={!newSectionName.trim() || submitting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded transition-colors"
            >
              {submitting ? t('splitSectionModal.submitting') : t('splitSectionModal.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
