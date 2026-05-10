import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Mapset } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { decrypt, mapsetFieldAad } from '../utils/crypto';

interface MapsetCardProps {
  mapset: Mapset;
  onUnlock?: (mapset: Mapset) => void;
}

export default function MapsetCard({ mapset, onUnlock }: MapsetCardProps) {
  const { isUnlocked, getKey } = useEncryption();
  const [title, setTitle] = useState<string | null>(null);
  const navigate = useNavigate();

  const unlocked = isUnlocked(mapset.id);

  useEffect(() => {
    if (!unlocked) {
      setTitle(null);
      return;
    }
    let cancelled = false;
    getKey(mapset.id).then(async (key) => {
      if (cancelled || !key) return;
      try {
        const aad = mapsetFieldAad(mapset.id, 'title');
        const decrypted = await decrypt(key, mapset.encrypted_title, aad);
        if (!cancelled) setTitle(decrypted);
      } catch {
        if (!cancelled) setTitle(null);
      }
    });
    return () => { cancelled = true; };
  }, [unlocked, mapset.id, mapset.encrypted_title, getKey]);

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
        {unlocked && title ? (
          <p className="text-white font-semibold truncate">{title}</p>
        ) : (
          <p className="text-gray-400 font-semibold">🔒 Encrypted Mapset</p>
        )}
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
