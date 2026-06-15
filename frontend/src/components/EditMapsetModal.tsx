import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEncryption } from '../contexts/EncryptionContext';
import { useToast } from '../contexts/ToastContext';
import { encrypt, mapsetFieldAad } from '../utils/crypto';
import { makeClampedOnChange } from '../utils/numericInput';
import { useUpdateMapset } from '../hooks/useMapset';
import type { UpdateMapsetPayload } from '../api/endpoints';
import { Button, Input, Modal } from './ui';

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
    <Modal open ariaLabelledBy="edit-mapset-title" onClose={onCancel} maxWidth="lg">
      <div className="p-6">
        <h2 id="edit-mapset-title" className="text-xl font-bold text-white mb-4">
          {t('editMapsetModal.title')}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            id="edit-mapset-title-input"
            label={t('editMapsetModal.titleLabel')}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={255}
            placeholder={t('editMapsetModal.titlePlaceholder')}
            autoFocus
            hint={t('editMapsetModal.titleWarning')}
          />

          <Input
            id="edit-mapset-description"
            label={t('editMapsetModal.descriptionLabel')}
            multiline
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('editMapsetModal.descriptionPlaceholder')}
          />

          <div>
            <span className="block text-sm font-medium text-muted-light mb-1">{t('editMapsetModal.songLengthLabel')}</span>
            <div className="flex gap-2">
              <Input
                id="edit-mapset-song-minutes"
                label={t('editMapsetModal.minutes')}
                type="number"
                value={minutes}
                onChange={makeClampedOnChange(setMinutes)}
                min={0}
                placeholder="0"
                className="flex-1"
              />
              <Input
                id="edit-mapset-song-seconds"
                label={t('editMapsetModal.seconds')}
                type="number"
                value={seconds}
                onChange={makeClampedOnChange(setSeconds, 59)}
                min={0}
                max={59}
                placeholder="0"
                className="flex-1"
              />
            </div>
          </div>

          {error && (
            <p role="alert" className="text-danger-muted text-sm">
              {error}
            </p>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!title.trim()} loading={submitting}>
              {submitting ? t('editMapsetModal.submitting') : t('editMapsetModal.submit')}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
