import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBaseOsuVersions, useActivateBaseOsuVersion } from '../hooks/useDifficulty';

interface BaseVersionHistoryProps {
  difficultyId: string;
  onClose: () => void;
}

export default function BaseVersionHistory({ difficultyId, onClose }: BaseVersionHistoryProps) {
  const { t } = useTranslation();
  const { data: versions, isLoading, error } = useBaseOsuVersions(difficultyId);
  const activateMutation = useActivateBaseOsuVersion(difficultyId);
  const [justActivated, setJustActivated] = useState<string | null>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  async function handleActivate(versionId: string) {
    if (activateMutation.isPending) return;
    await activateMutation.mutateAsync(versionId);
    setJustActivated(versionId);
    setTimeout(() => setJustActivated((current) => (current === versionId ? null : current)), 2000);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="base-version-history-title"
        className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-lg w-full mx-4 shadow-xl max-h-[80vh] flex flex-col"
      >
        <h3 id="base-version-history-title" className="text-lg font-semibold text-white mb-4">
          {t('baseHistory.title')}
        </h3>

        {isLoading && <p className="text-sm text-gray-400">{t('baseHistory.loading')}</p>}
        {error && <p className="text-sm text-red-400">{t('baseHistory.error')}</p>}

        <div className="overflow-y-auto flex-1 space-y-2">
          {versions && versions.length === 0 && (
            <p className="text-sm text-gray-400 italic">{t('baseHistory.empty')}</p>
          )}
          {versions?.map((v) => (
            <div
              key={v.id}
              className={[
                'flex items-center justify-between rounded-lg border p-3',
                v.is_active
                  ? 'border-blue-500 bg-blue-900/20'
                  : 'border-gray-700 bg-gray-800',
              ].join(' ')}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-white">
                  v{v.version}
                  {v.is_active && (
                    <span className="ml-2 text-xs text-blue-400 font-semibold">{t('baseHistory.active')}</span>
                  )}
                </p>
                <p className="text-xs text-gray-500">
                  {new Date(v.created_at).toLocaleString()}
                </p>
              </div>
              {!v.is_active && (
                <button
                  type="button"
                  onClick={() => handleActivate(v.id)}
                  disabled={activateMutation.isPending}
                  className="px-3 py-1.5 min-w-[5.5rem] bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 text-white text-xs font-medium rounded transition-colors shrink-0 ml-2"
                >
                  {activateMutation.isPending && justActivated !== v.id
                    ? t('baseHistory.activating')
                    : justActivated === v.id
                      ? t('baseHistory.activated')
                      : t('baseHistory.activate')}
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end mt-4 pt-3 border-t border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
          >
            {t('baseHistory.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
