import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Mapset } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { Button, Input, Modal } from './ui';

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
    <Modal open ariaLabelledBy="passphrase-modal-title" onClose={onCancel ?? (() => {})} closeOnBackdrop={false} closeOnEscape={false}>
      <div className="p-6">
        <h2 id="passphrase-modal-title" className="text-xl font-bold text-white mb-2">
          {t('passphraseModal.title')}
        </h2>
        <p className="text-muted-light text-sm mb-4">
          {t('passphraseModal.intro')}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            id="passphrase-input"
            label={t('passphraseModal.label')}
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={t('passphraseModal.placeholder')}
            autoComplete="off"
            autoFocus
          />

          {error && (
            <p role="alert" className="text-danger-muted text-sm">
              {error}
            </p>
          )}

          <div className="flex gap-3 justify-end">
            {onCancel && (
              <Button type="button" variant="ghost" onClick={onCancel}>
                {t('common.cancel')}
              </Button>
            )}
            <Button type="submit" disabled={loading || !passphrase} loading={loading}>
              {loading ? t('passphraseModal.submitting') : t('passphraseModal.submit')}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
