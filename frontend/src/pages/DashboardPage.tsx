import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Mapset } from '../api/endpoints';
import CreateMapsetModal from '../components/CreateMapsetModal';
import FrostedPanel from '../components/FrostedPanel';
import MapsetCard from '../components/MapsetCard';
import TopBar from '../components/TopBar';
import PassphraseModal from '../components/PassphraseModal';
import { useKickedMapsets, useMapsets, useStorage } from '../hooks/useMapset';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export default function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: mapsets, isLoading, isError } = useMapsets();
  const { data: kickedMapsets } = useKickedMapsets();
  const { data: storage } = useStorage();
  const [showCreate, setShowCreate] = useState(false);
  const [unlockTarget, setUnlockTarget] = useState<Mapset | null>(null);

  const storagePct = storage
    ? Math.min((storage.used_bytes / storage.limit_bytes) * 100, 100)
    : 0;
  const storageColor =
    storagePct >= 90 ? 'bg-red-500' : storagePct >= 70 ? 'bg-yellow-400' : 'bg-green-500';

  const { activeMapsets, toBeDeletedMapsets } = useMemo(() => {
    const active: Mapset[] = [];
    const toBeDeleted: Mapset[] = [];
    for (const m of mapsets ?? []) {
      (m.delete_at ? toBeDeleted : active).push(m);
    }
    return { activeMapsets: active, toBeDeletedMapsets: toBeDeleted };
  }, [mapsets]);

  return (
    <div className="min-h-screen text-white px-8 pb-8 pt-20">
      <TopBar />
      <FrostedPanel className="max-w-4xl mx-auto mt-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold text-blue-400">{t('dashboard.title')}</h1>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 bg-pink-500 hover:bg-pink-600 rounded-lg font-semibold transition-colors"
          >
            {t('dashboard.createMapset')}
          </button>
        </div>

        {storage && (
          <div className="mb-6">
            <div className="flex justify-between text-sm text-gray-400 mb-1">
              <span>
                {t('dashboard.storageUsed')}
                {storage.pending_bytes > 0 && (
                  <span className="text-gray-500 ml-2">
                    ({t('dashboard.storagePending', { amount: formatBytes(storage.pending_bytes) })})
                  </span>
                )}
              </span>
              <span>{formatBytes(storage.used_bytes)} / {formatBytes(storage.limit_bytes)}</span>
            </div>
            <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${storageColor}`}
                style={{ width: `${storagePct}%` }}
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

        {activeMapsets.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {activeMapsets.map((mapset) => (
              <MapsetCard
                key={mapset.id}
                mapset={mapset}
                onUnlock={(m) => setUnlockTarget(m)}
              />
            ))}
          </div>
        )}

        {toBeDeletedMapsets.length > 0 && (
          <div className="mt-8" data-testid="to-be-deleted-section">
            <h2 className="text-lg font-semibold text-gray-400 mb-3">
              {t('dashboard.toBeDeletedHeading')}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {toBeDeletedMapsets.map((mapset) => (
                <MapsetCard
                  key={mapset.id}
                  mapset={mapset}
                  onUnlock={(m) => setUnlockTarget(m)}
                />
              ))}
            </div>
          </div>
        )}

        {kickedMapsets && kickedMapsets.length > 0 && (
          <div className="mt-8">
            <h2 className="text-lg font-semibold text-gray-400 mb-3">{t('dashboard.removedFromHeading')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {kickedMapsets.map((mapset) => {
                const daysLeft = Math.max(
                  0,
                  Math.ceil((new Date(mapset.access_expires_at).getTime() - Date.now()) / 86_400_000),
                );
                return (
                  <div
                    key={mapset.id}
                    className="bg-gray-800 border border-gray-700 rounded-lg p-4 flex items-center justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-white font-semibold truncate">{mapset.title}</p>
                        <span className="shrink-0 text-xs bg-gray-600 text-gray-300 px-1.5 py-0.5 rounded">
                          {t('dashboard.removedBadge')}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        {daysLeft === 0
                          ? t('dashboard.accessImminent')
                          : t('dashboard.accessExpiresIn', { count: daysLeft })}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => navigate(`/mapsets/${mapset.id}`)}
                      className="shrink-0 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
                    >
                      {t('dashboard.viewMapset')}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </FrostedPanel>

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
