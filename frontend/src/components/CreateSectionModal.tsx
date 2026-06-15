import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEncryption } from '../contexts/EncryptionContext';
import { encrypt, sectionFieldAad } from '../utils/crypto';
import { useCreateSection } from '../hooks/useDifficulty';
import { formatTimestamp, parseTimestampString } from '../utils/extractTimestamp';
import { Button, Input, Modal } from './ui';

interface PreviousSection {
  id: string;
  endTimeMs: number;
  sortOrder: number;
}

interface CreateSectionModalProps {
  difficultyId: string;
  mapsetId: string;
  previousSections?: PreviousSection[];
  songLengthMs?: number | null;
  onSuccess: () => void;
  onCancel: () => void;
}

export default function CreateSectionModal({
  difficultyId,
  mapsetId,
  previousSections = [],
  songLengthMs,
  onSuccess,
  onCancel,
}: CreateSectionModalProps) {
  const { t } = useTranslation();
  const { getKey } = useEncryption();
  const createSection = useCreateSection(difficultyId);

  const startMs = useMemo(() => {
    if (previousSections.length === 0) return 0;
    return Math.max(...previousSections.map((s) => s.endTimeMs));
  }, [previousSections]);

  const [name, setName] = useState('');
  const [endTimeInput, setEndTimeInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    setSubmitting(true);

    try {
      const key = await getKey(mapsetId);
      if (!key) {
        setError(t('createSectionModal.errorKeyMissing'));
        setSubmitting(false);
        return;
      }

      const parsed = parseTimestampString(endTimeInput);
      if (!parsed) {
        setError(t('createSectionModal.errorInvalidFormat'));
        setSubmitting(false);
        return;
      }

      const endMs = parsed.ms;

      if (endMs < startMs + 1000) {
        setError(t('createSectionModal.errorTooEarly', { time: formatTimestamp(startMs) }));
        setSubmitting(false);
        return;
      }

      if (songLengthMs !== null && songLengthMs !== undefined && endMs > songLengthMs) {
        setError(t('createSectionModal.errorPastSong', { time: formatTimestamp(songLengthMs) }));
        setSubmitting(false);
        return;
      }

      const id = crypto.randomUUID();
      const order =
        previousSections.length === 0
          ? 0
          : Math.max(...previousSections.map((s) => s.sortOrder)) + 1;

      const [encryptedName, encryptedStart, encryptedEnd, encryptedSort] = await Promise.all([
        encrypt(key, name.trim(), sectionFieldAad(id, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: startMs }), sectionFieldAad(id, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: endMs }), sectionFieldAad(id, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: order }), sectionFieldAad(id, mapsetId)),
      ]);

      await createSection.mutateAsync({
        id,
        encrypted_name: encryptedName,
        encrypted_start_time_ms: encryptedStart,
        encrypted_end_time_ms: encryptedEnd,
        encrypted_sort_order: encryptedSort,
      });

      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('createSectionModal.errorGeneric');
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open ariaLabelledBy="create-section-title" onClose={onCancel}>
      <div className="p-6">
        <h2 id="create-section-title" className="text-xl font-bold text-white mb-4">
          {t('createSectionModal.title')}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            id="section-name"
            label={t('createSectionModal.nameLabel')}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={255}
            placeholder={t('createSectionModal.namePlaceholder')}
          />

          <div>
            <span className="block text-sm font-medium text-muted-light mb-1">{t('createSectionModal.startTimeLabel')}</span>
            <p className="text-sm text-muted-light">
              {formatTimestamp(startMs)} <span className="text-xs text-muted">{t('createSectionModal.startTimeHint')}</span>
            </p>
          </div>

          <Input
            id="section-end-time"
            label={t('createSectionModal.endTimeLabel')}
            type="text"
            value={endTimeInput}
            onChange={(e) => setEndTimeInput(e.target.value)}
            required
            placeholder={t('createSectionModal.endTimePlaceholder')}
            className="font-mono"
            hint={t('createSectionModal.endTimeFormatHint')}
          />

          {error && (
            <p role="alert" className="text-danger-muted text-sm">
              {error}
            </p>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim()} loading={submitting}>
              {submitting ? t('createSectionModal.submitting') : t('createSectionModal.submit')}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
