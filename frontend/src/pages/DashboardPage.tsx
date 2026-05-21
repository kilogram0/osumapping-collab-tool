import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Mapset } from '../api/endpoints';
import CreateMapsetModal from '../components/CreateMapsetModal';
import LanguageSwitcher from '../components/LanguageSwitcher';
import MapsetCard from '../components/MapsetCard';
import PassphraseModal from '../components/PassphraseModal';
import { useMapsets, useQuota } from '../hooks/useMapset';

export default function DashboardPage() {
  const { t } = useTranslation();
  const { data: mapsets, isLoading, isError } = useMapsets();
  const { data: quota } = useQuota();
  const [showCreate, setShowCreate] = useState(false);
  const [unlockTarget, setUnlockTarget] = useState<Mapset | null>(null);

  const quotaPct = quota ? Math.min((quota.used / quota.limit) * 100, 100) : 0;
  const quotaColor =
    quotaPct >= 90 ? 'bg-red-500' : quotaPct >= 70 ? 'bg-yellow-400' : 'bg-green-500';

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold text-blue-400">{t('dashboard.title')}</h1>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 bg-pink-500 hover:bg-pink-600 rounded-lg font-semibold transition-colors"
            >
              {t('dashboard.createMapset')}
            </button>
          </div>
        </div>

        {quota && (
          <div className="mb-6">
            <div className="flex justify-between text-sm text-gray-400 mb-1">
              <span>{t('dashboard.difficultySlots')}</span>
              <span>{quota.used} / {quota.limit}</span>
            </div>
            <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${quotaColor}`}
                style={{ width: `${quotaPct}%` }}
              />
            </div>
          </div>
        )}

        {isLoading && (
          <p className="text-gray-400">{t('dashboard.loadingMapsets')}</p>
        )}

        {isError && (
          <p className="text-red-400">{t('dashboard.failedToLoadMapsets')}</p>
        )}

        {mapsets && mapsets.length === 0 && (
          <p className="text-gray-400">{t('dashboard.emptyState')}</p>
        )}

        {mapsets && mapsets.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {mapsets.map((mapset) => (
              <MapsetCard
                key={mapset.id}
                mapset={mapset}
                onUnlock={(m) => setUnlockTarget(m)}
              />
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateMapsetModal
          onSuccess={() => setShowCreate(false)}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {unlockTarget && (
        <PassphraseModal
          mapset={unlockTarget}
          onSuccess={() => setUnlockTarget(null)}
          onCancel={() => setUnlockTarget(null)}
        />
      )}
    </div>
  );
}
