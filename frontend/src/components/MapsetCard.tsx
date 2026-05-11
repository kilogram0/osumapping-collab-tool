import { useNavigate } from 'react-router-dom';
import type { Mapset } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';

interface MapsetCardProps {
  mapset: Mapset;
  onUnlock?: (mapset: Mapset) => void;
}

export default function MapsetCard({ mapset, onUnlock }: MapsetCardProps) {
  const { isUnlocked } = useEncryption();
  const navigate = useNavigate();

  const unlocked = isUnlocked(mapset.id);

  function handleClick() {
    navigate(`/mapsets/${mapset.id}`);
  }

  function handleUnlock(e: React.MouseEvent) {
    e.stopPropagation();
    onUnlock?.(mapset);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleClick()}
      className="bg-gray-800 hover:bg-gray-750 border border-gray-700 rounded-lg p-4 cursor-pointer transition-colors flex items-center justify-between gap-4"
      data-testid="mapset-card"
    >
      <div className="min-w-0">
        <p className="text-white font-semibold truncate">{mapset.title}</p>
        <p className="text-xs text-gray-500 mt-1">
          {new Date(mapset.created_at).toLocaleDateString()}
        </p>
      </div>

      {!unlocked && onUnlock && (
        <button
          onClick={handleUnlock}
          className="shrink-0 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
          aria-label="Unlock mapset"
        >
          Unlock
        </button>
      )}
    </div>
  );
}
