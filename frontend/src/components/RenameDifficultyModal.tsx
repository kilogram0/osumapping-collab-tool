import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEncryption } from '../contexts/EncryptionContext';
import { useToast } from '../contexts/ToastContext';
import { encrypt, difficultyFieldAad } from '../utils/crypto';
import { useUpdateDifficulty } from '../hooks/useDifficulty';

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
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-difficulty-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-full max-w-md shadow-xl">
        <h2 id="rename-difficulty-title" className="text-xl font-bold text-white mb-4">
          {t('renameDifficultyModal.title')}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="rename-difficulty-name" className="block text-sm font-medium text-gray-300 mb-1">
              {t('renameDifficultyModal.nameLabel')} <span className="text-red-400">{t('common.required')}</span>
            </label>
            <input
              id="rename-difficulty-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={255}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              autoFocus
            />
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
              {submitting ? t('renameDifficultyModal.submitting') : t('renameDifficultyModal.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
