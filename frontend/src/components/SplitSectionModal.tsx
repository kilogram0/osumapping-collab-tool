import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatTimestamp, parseTimestampString } from '../utils/extractTimestamp';
import type { DecryptedSection } from './SectionList';
import { Button, Input, Modal } from './ui';

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
    <Modal open ariaLabelledBy="split-section-title" onClose={onCancel}>
      <div className="p-6">
        <h2 id="split-section-title" className="text-xl font-bold text-white mb-4">
          {t('splitSectionModal.title')}
        </h2>

        <p className="text-sm text-muted-light mb-4">
          {t('splitSectionModal.rangeHint', {
            start: formatTimestamp(section.startTimeMs),
            end: formatTimestamp(section.endTimeMs),
          })}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            id="split-time"
            label={t('splitSectionModal.splitTimeLabel')}
            type="text"
            value={splitTimeInput}
            onChange={(e) => setSplitTimeInput(e.target.value)}
            required
            placeholder={t('splitSectionModal.splitTimePlaceholder')}
            className="font-mono"
            hint={t('splitSectionModal.splitTimeFormatHint')}
          />

          <Input
            id="new-section-name"
            label={t('splitSectionModal.newSectionNameLabel')}
            type="text"
            value={newSectionName}
            onChange={(e) => setNewSectionName(e.target.value)}
            required
            maxLength={255}
            placeholder={t('splitSectionModal.newSectionNamePlaceholder')}
          />

          {displayedError && (
            <p role="alert" className="text-danger-muted text-sm">
              {displayedError}
            </p>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!newSectionName.trim()} loading={submitting}>
              {submitting ? t('splitSectionModal.submitting') : t('splitSectionModal.submit')}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
