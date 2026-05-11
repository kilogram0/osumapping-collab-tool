import { useEffect, useState } from 'react';
import type { Difficulty } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { decrypt, difficultyFieldAad } from '../utils/crypto';
import { logger } from '../utils/logger';

interface DifficultyTabsProps {
  difficulties: Difficulty[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  mapsetId: string;
}

export default function DifficultyTabs({ difficulties, selectedId, onSelect, mapsetId }: DifficultyTabsProps) {
  const { isUnlocked, getKey } = useEncryption();
  const [names, setNames] = useState<Record<string, string>>({});
  const unlocked = isUnlocked(mapsetId);

  useEffect(() => {
    if (!unlocked) {
      setNames({});
      return;
    }
    let cancelled = false;

    async function decryptAll() {
      const key = await getKey(mapsetId);
      if (!key || cancelled) return;
      const decrypted: Record<string, string> = {};
      await Promise.all(
        difficulties.map(async (d) => {
          try {
            const plaintext = await decrypt(key, d.encrypted_name, difficultyFieldAad(d.id, mapsetId, 'name'));
            decrypted[d.id] = plaintext;
          } catch (_err) {
            logger.warn(`Failed to decrypt difficulty name for ${d.id}:`, _err);
          }
        }),
      );
      if (!cancelled) setNames(decrypted);
    }

    decryptAll();
    return () => { cancelled = true; };
  }, [unlocked, difficulties, mapsetId, getKey]);

  if (difficulties.length === 0) {
    return (
      <p className="text-sm text-gray-500 italic">No difficulties yet.</p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Difficulties">
      {difficulties.map((d) => {
        const isSelected = d.id === selectedId;
        const name = unlocked ? (names[d.id] ?? '🔒 Encrypted Difficulty') : '🔒 Encrypted Difficulty';
        return (
          <button
            key={d.id}
            role="tab"
            aria-selected={isSelected}
            onClick={() => onSelect(d.id)}
            className={[
              'px-4 py-2 rounded-lg text-sm font-medium transition-colors border',
              isSelected
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-750 hover:text-white',
            ].join(' ')}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}
