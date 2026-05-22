import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Difficulty } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { decrypt, difficultyFieldAad } from '../utils/crypto';
import { logger } from '../utils/logger';

interface PendingDifficultyListProps {
  difficulties: Difficulty[];
  mapsetId: string;
  onRestore: (difficultyId: string) => void;
  restoringId: string | null;
}

/**
 * Renders difficulties scheduled for purge (delete_at IS NOT NULL).
 *
 * Intentionally NOT a tab: pending-deletion rows have no editable surface and
 * adding them to DifficultyTabs would let the user "select" a row that has no
 * sections/posts to back it.
 */
export default function PendingDifficultyList({
  difficulties,
  mapsetId,
  onRestore,
  restoringId,
}: PendingDifficultyListProps) {
  const { t } = useTranslation();
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
      const out: Record<string, string> = {};
      await Promise.all(
        difficulties.map(async (d) => {
          try {
            out[d.id] = await decrypt(
              key,
              d.encrypted_name,
              difficultyFieldAad(d.id, mapsetId),
            );
          } catch (err) {
            logger.warn(`Failed to decrypt pending difficulty ${d.id}:`, err);
          }
        }),
      );
      if (!cancelled) setNames(out);
    }
    decryptAll();
    return () => {
      cancelled = true;
    };
  }, [unlocked, difficulties, mapsetId, getKey]);

  const items = useMemo(
    () =>
      difficulties.map((d) => {
        const expiresAt = d.delete_at ? new Date(d.delete_at).getTime() : null;
        const daysLeft =
          expiresAt === null
            ? null
            : Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000));
        return { difficulty: d, daysLeft };
      }),
    [difficulties],
  );

  if (difficulties.length === 0) {
    return (
      <p className="text-sm text-gray-500 italic">
        {t('mapsetPage.noPendingDifficulties')}
      </p>
    );
  }

  return (
    <ul className="space-y-2" data-testid="pending-difficulty-list">
      {items.map(({ difficulty, daysLeft }) => {
        const name = unlocked
          ? names[difficulty.id] ?? t('difficultyTabs.encrypted')
          : t('difficultyTabs.encrypted');
        const isRestoring = restoringId === difficulty.id;
        return (
          <li
            key={difficulty.id}
            className="flex items-center justify-between gap-3 bg-gray-800 border border-gray-700 rounded p-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-400 line-through truncate">
                {name}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {daysLeft === null
                  ? t('mapsetPage.pendingExpiresUnknown')
                  : daysLeft === 0
                  ? t('mapsetPage.pendingExpiresImminent')
                  : t('mapsetPage.pendingExpiresInDays', { count: daysLeft })}
              </p>
            </div>
            <button
              type="button"
              disabled={isRestoring}
              onClick={() => onRestore(difficulty.id)}
              className="shrink-0 px-3 py-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors"
            >
              {isRestoring ? t('mapsetPage.restoring') : t('mapsetPage.restore')}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
