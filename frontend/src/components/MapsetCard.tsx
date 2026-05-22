import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Mapset } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { useAuth } from '../hooks/useAuth';
import { useCancelMapsetDeletion, useScheduleMapsetDeletion } from '../hooks/useMapset';

interface MapsetCardProps {
  mapset: Mapset;
  onUnlock?: (mapset: Mapset) => void;
}

export default function MapsetCard({ mapset, onUnlock }: MapsetCardProps) {
  const { t } = useTranslation();
  const { isUnlocked } = useEncryption();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const scheduleDelete = useScheduleMapsetDeletion();
  const cancelDelete = useCancelMapsetDeletion();

  const unlocked = isUnlocked(mapset.id);
  const isOwner = !!user && user.id === mapset.owner_id;
  const isPendingDeletion = !!mapset.delete_at;

  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [menuOpen]);

  function handleClick() {
    navigate(`/mapsets/${mapset.id}`);
  }

  function handleUnlock(e: React.MouseEvent) {
    e.stopPropagation();
    onUnlock?.(mapset);
  }

  function handleMenuToggle(e: React.MouseEvent) {
    e.stopPropagation();
    setMenuOpen((open) => !open);
  }

  function handleScheduleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    setMenuOpen(false);
    scheduleDelete.mutate(mapset.id);
  }

  function handleCancelDelete(e: React.MouseEvent) {
    e.stopPropagation();
    setMenuOpen(false);
    cancelDelete.mutate(mapset.id);
  }

  const daysLeft = isPendingDeletion
    ? Math.max(0, Math.ceil((new Date(mapset.delete_at!).getTime() - Date.now()) / 86_400_000))
    : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleClick()}
      className={`bg-gray-800 hover:bg-gray-750 border rounded-lg p-4 cursor-pointer transition-colors flex items-center justify-between gap-4 h-24 ${
        isPendingDeletion ? 'border-red-500/60' : 'border-gray-700'
      }`}
      data-testid="mapset-card"
    >
      <div className="min-w-0">
        <p className="text-white font-semibold truncate">{mapset.title}</p>
        <div className="flex items-center gap-2 mt-1">
          <p className="text-xs text-gray-500">
            {new Date(mapset.created_at).toLocaleDateString()}
          </p>
          <span className="text-xs text-gray-400 bg-gray-700 px-1.5 py-0.5 rounded">
            {t('mapsetCard.diff', { count: mapset.difficulty_count })}
          </span>
        </div>
        {isPendingDeletion && (
          <p className="text-xs text-red-400 mt-1">
            {daysLeft === 0
              ? t('mapsetCard.deletionImminent')
              : t('mapsetCard.scheduledDeletion', { count: daysLeft ?? 0 })}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {!unlocked && onUnlock && (
          <button
            onClick={handleUnlock}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
            aria-label={t('mapsetCard.unlockAria')}
          >
            {t('mapsetCard.unlock')}
          </button>
        )}

        {isOwner && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={handleMenuToggle}
              className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
              aria-label={t('mapsetCard.menuAria')}
              data-testid="mapset-menu-button"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <circle cx="8" cy="2" r="1.5" />
                <circle cx="8" cy="8" r="1.5" />
                <circle cx="8" cy="14" r="1.5" />
              </svg>
            </button>

            {menuOpen && (
              <div
                className="absolute right-0 top-8 z-10 w-44 bg-gray-800 border border-gray-700 rounded-lg shadow-lg py-1"
                data-testid="mapset-menu"
              >
                {isPendingDeletion ? (
                  <button
                    onClick={handleCancelDelete}
                    className="w-full text-left px-4 py-2 text-sm text-green-400 hover:bg-gray-700 transition-colors"
                    data-testid="cancel-delete-button"
                  >
                    {t('mapsetCard.cancelDeletion')}
                  </button>
                ) : (
                  <button
                    onClick={handleScheduleDelete}
                    className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-gray-700 transition-colors"
                    data-testid="schedule-delete-button"
                  >
                    {t('mapsetCard.delete')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
