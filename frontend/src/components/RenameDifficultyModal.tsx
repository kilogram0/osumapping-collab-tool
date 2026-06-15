import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEncryption } from '../contexts/EncryptionContext';
import { useToast } from '../contexts/ToastContext';
import { encrypt, difficultyFieldAad } from '../utils/crypto';
import { useUpdateDifficulty } from '../hooks/useDifficulty';
import { Button, Input, Modal } from './ui';

interface RenameDifficultyModalProps {
  mapsetId: string;
  difficultyId: string;
  currentName: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export default function RenameDifficultyModal({
  mapsetId,
  difficultyId,
  currentName,
  onSuccess,
  onCancel,
}: RenameDifficultyModalProps) {
  const { t } = useTranslation();
  const { getKey } = useEncryption();
  const { showToast } = useToast();
  const updateDifficulty = useUpdateDifficulty(mapsetId);

  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === currentName) {
      onCancel();
      return;
    }
    setError(null);
    setSubmitting(true);

    try {
      const key = await getKey(mapsetId);
      if (!key) {
        setError(t('renameDifficultyModal.errorKeyMissing'));
        setSubmitting(false);
        return;
      }

      const encryptedName = await encrypt(key, trimmed, difficultyFieldAad(difficultyId, mapsetId));
      await updateDifficulty.mutateAsync({
        difficultyId,
        payload: { encrypted_name: encryptedName },
      });
      showToast(t('renameDifficultyModal.toastRenamed'), 'success');
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('renameDifficultyModal.errorGeneric'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open ariaLabelledBy="rename-difficulty-title" onClose={onCancel}>
      <div className="p-6">
        <h2 id="rename-difficulty-title" className="text-xl font-bold text-white mb-4">
          {t('renameDifficultyModal.title')}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            id="rename-difficulty-name"
            label={t('renameDifficultyModal.nameLabel')}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={255}
            autoFocus
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
              {submitting ? t('renameDifficultyModal.submitting') : t('renameDifficultyModal.submit')}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
