import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useEncryption } from '../contexts/EncryptionContext';
import { encrypt, sectionFieldAad } from '../utils/crypto';
import { useUpdateSection } from '../hooks/useDifficulty';
import { formatTimestamp, parseTimestampString } from '../utils/extractTimestamp';
import { redistributeForShorten } from '../utils/sectionRedistribute';
import { Button, Input, Modal } from './ui';

interface EditSectionModalProps {
  difficultyId: string;
  mapsetId: string;
  sectionId: string;
  initialName: string;
  initialStartTimeMs: number;
  initialEndTimeMs: number;
  /** ID of the section that follows this one in sortOrder, if any. When the
   *  edit shortens this section, any hit objects past the new end time are
   *  migrated into the next section so they aren't silently dropped by the
   *  merge clipper (see osuMerge §3). */
  nextSectionId?: string | null;
  /** End time of the section that follows this one, if any. Used to keep the
   *  next section at least MIN_SECTION_MS long. */
  nextSectionEndTimeMs?: number | null;
  /** Total song length in ms; the section's end time may not exceed this. */
  songLengthMs?: number | null;
  /** Called with the section's new end time (ms) on a successful save, so the
   *  caller can keep the base template's bookmarks in sync with the divisions. */
  onSuccess: (newEndMs: number) => void;
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
  nextSectionId,
  nextSectionEndTimeMs,
  songLengthMs,
  onSuccess,
  onCancel,
}: EditSectionModalProps) {
  const { t } = useTranslation();
  const { getKey } = useEncryption();
  const updateSection = useUpdateSection(difficultyId);
  const queryClient = useQueryClient();

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

      // updateSection.mutateAsync calls PATCH /sections/:id, which is a
      // plain mutable-row update — no version rows are created. Retrying
      // with the same payload is safe and does not inflate history.
      //
      // Order: persist the new end time first, redistribute second. We have
      // no server-side transaction across both, so something has to give:
      //   - update first, then redistribute: if redistribute fails on retry,
      //     splitSectionAtTime still sees objects past newEndMs in the
      //     source blob and re-uploads idempotently (mergeHitObjectsInto
      //     dedupes). The merge clipper preserves the appearance of the
      //     stray objects being in the next section's range until the retry
      //     lands, but no data is lost in storage.
      //   - redistribute first, then update: if update fails, the source's
      //     trailing objects have already moved into next's blob below
      //     next's eventual startTimeMs. The clipper will drop them and the
      //     user has no signal to retry, since splitSectionAtTime now finds
      //     nothing to move. That's silent data loss after a transient
      //     failure — worse than the above.
      await updateSection.mutateAsync({ sectionId, payload });

      if (nextSectionId && endMs < initialEndTimeMs) {
        await redistributeForShorten({
          difficultyId,
          mapsetId,
          sourceSectionId: sectionId,
          nextSectionId,
          newEndMs: endMs,
          key,
        });
        queryClient.invalidateQueries({ queryKey: ['sections', difficultyId] });
        queryClient.invalidateQueries({ queryKey: ['section-osu-versions', difficultyId, sectionId] });
        queryClient.invalidateQueries({ queryKey: ['section-osu-versions', difficultyId, nextSectionId] });
      }

      onSuccess(endMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('editSectionModal.errorGeneric');
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open ariaLabelledBy="edit-section-title" onClose={onCancel}>
      <div className="p-6">
        <h2 id="edit-section-title" className="text-xl font-bold text-white mb-4">
          {t('editSectionModal.title')}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            id="edit-section-name"
            label={t('editSectionModal.nameLabel')}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={255}
          />

          <div>
            <span className="block text-sm font-medium text-muted-light mb-1">{t('editSectionModal.startTimeLabel')}</span>
            <p className="text-sm text-muted-light">
              {formatTimestamp(initialStartTimeMs)} <span className="text-xs text-muted">{t('editSectionModal.startTimeHint')}</span>
            </p>
          </div>

          <Input
            id="edit-section-end-time"
            label={t('editSectionModal.endTimeLabel')}
            type="text"
            value={endTimeInput}
            onChange={(e) => setEndTimeInput(e.target.value)}
            required
            placeholder={t('editSectionModal.endTimePlaceholder')}
            className="font-mono"
            hint={t('editSectionModal.endTimeFormatHint')}
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
              {submitting ? t('editSectionModal.submitting') : t('editSectionModal.submit')}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
