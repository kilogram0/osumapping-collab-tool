import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Mapset } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';

interface PassphraseModalProps {
  mapset: Mapset;
  onSuccess: () => void;
  onCancel?: () => void;
}

export default function PassphraseModal({ mapset, onSuccess, onCancel }: PassphraseModalProps) {
  const { t } = useTranslation();
  const { unlockMapset } = useEncryption();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await unlockMapset(mapset.id, passphrase, mapset.passphrase_salt, mapset.encrypted_verification);
      onSuccess();
    } catch {
      setError(t('passphraseModal.incorrect'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="passphrase-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    >
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-full max-w-md shadow-xl">
        <h2 id="passphrase-modal-title" className="text-xl font-bold text-white mb-2">
          {t('passphraseModal.title')}
        </h2>
        <p className="text-gray-400 text-sm mb-4">
          {t('passphraseModal.intro')}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="passphrase-input" className="block text-sm font-medium text-gray-300 mb-1">
              {t('passphraseModal.label')}
            </label>
            <input
              id="passphrase-input"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              placeholder={t('passphraseModal.placeholder')}
              autoComplete="off"
              autoFocus
            />
          </div>

          {error && (
            <p role="alert" className="text-red-400 text-sm">
              {error}
            </p>
          )}

          <div className="flex gap-3 justify-end">
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 text-gray-300 hover:text-white transition-colors"
              >
                {t('common.cancel')}
              </button>
            )}
            <button
              type="submit"
              disabled={loading || !passphrase}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded transition-colors"
            >
              {loading ? t('passphraseModal.submitting') : t('passphraseModal.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
