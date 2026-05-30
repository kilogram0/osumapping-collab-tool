import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { Difficulty } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { decrypt, difficultyFieldAad } from '../utils/crypto';
import { logger } from '../utils/logger';

interface DifficultyDropdownProps {
  activeDifficulties: Difficulty[];
  /** Soft-deleted difficulties (delete_at set). Only rendered for owners. */
  pendingDifficulties: Difficulty[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  mapsetId: string;
  /**
   * Receives the freshly-decrypted difficulty name map (active + pending).
   * Typed as a `useState` setter so the stability requirement is structural —
   * inline lambdas won't satisfy the type, avoiding a re-decrypt loop.
   */
  onDecrypted?: Dispatch<SetStateAction<Record<string, string>>>;
  /** Whether the current user may add a difficulty (owner or mapper). */
  canAdd: boolean;
  /** Whether the current user owns the mapset (gates rename/delete/restore). */
  isOwner: boolean;
  onAddDifficulty: () => void;
  onRenameDifficulty: (id: string, currentName: string) => void;
  onDeleteDifficulty: (id: string, currentName: string) => void;
  onRestoreDifficulty: (id: string) => void;
  onDownloadDifficulty: (id: string, name: string) => void;
  restoringId: string | null;
  downloadingId: string | null;
}

const ICON_BTN =
  'p-1.5 rounded text-gray-300 hover:text-white hover:bg-gray-700 disabled:opacity-50 disabled:hover:bg-transparent transition-colors';

/** Whole days remaining until a soft-deleted difficulty is purged (floored at 0). */
function daysUntilPurge(deleteAt: string | null): number | null {
  if (!deleteAt) return null;
  return Math.max(0, Math.ceil((new Date(deleteAt).getTime() - Date.now()) / 86_400_000));
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

function PenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.5 2.5l2 2L6 12l-2.5.5.5-2.5 7.5-7.5z" />
      <path d="M10 4l2 2" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.5 8h5l.5-8" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8a5 5 0 1 1 1.5 3.5M3 8V5M3 8h3" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5v7M5 7l3 3 3-3M3 12.5h10" />
    </svg>
  );
}

export default function DifficultyDropdown({
  activeDifficulties,
  pendingDifficulties,
  selectedId,
  onSelect,
  mapsetId,
  onDecrypted,
  canAdd,
  isOwner,
  onAddDifficulty,
  onRenameDifficulty,
  onDeleteDifficulty,
  onRestoreDifficulty,
  onDownloadDifficulty,
  restoringId,
  downloadingId,
}: DifficultyDropdownProps) {
  const { t } = useTranslation();
  const { isUnlocked, getKey } = useEncryption();
  const [names, setNames] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const unlocked = isUnlocked(mapsetId);
  const encryptedLabel = t('difficultyTabs.encrypted');

  useEffect(() => {
    if (!unlocked) {
      setNames({});
      onDecrypted?.({});
      return;
    }
    let cancelled = false;

    async function decryptAll() {
      const key = await getKey(mapsetId);
      if (!key || cancelled) return;
      const decrypted: Record<string, string> = {};
      await Promise.all(
        [...activeDifficulties, ...pendingDifficulties].map(async (d) => {
          try {
            decrypted[d.id] = await decrypt(key, d.encrypted_name, difficultyFieldAad(d.id, mapsetId));
          } catch (_err) {
            logger.warn(`Failed to decrypt difficulty name for ${d.id}:`, _err);
          }
        }),
      );
      if (!cancelled) {
        setNames(decrypted);
        onDecrypted?.(decrypted);
      }
    }

    decryptAll();
    return () => { cancelled = true; };
  }, [unlocked, activeDifficulties, pendingDifficulties, mapsetId, getKey, onDecrypted]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const nameFor = (d: Difficulty) =>
    unlocked ? (names[d.id] ?? encryptedLabel) : encryptedLabel;

  const triggerLabel = selectedId
    ? (unlocked ? (names[selectedId] ?? encryptedLabel) : encryptedLabel)
    : t('difficultyDropdown.placeholder');

  const listboxId = `difficulty-listbox-${mapsetId}`;

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0 text-left">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={t('difficultyDropdown.toggle')}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 rounded-lg text-sm font-medium border bg-gray-800 border-gray-700 text-white hover:bg-gray-750 transition-colors"
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t('difficultyDropdown.ariaLabel')}
          className="absolute left-0 right-0 z-30 mt-1 max-h-96 overflow-y-auto rounded-lg border border-gray-700 bg-gray-800 shadow-xl py-1"
        >
          {canAdd && (
            <button
              type="button"
              onClick={() => { onAddDifficulty(); setOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium text-pink-400 hover:bg-gray-750 transition-colors"
            >
              <PlusIcon />
              {t('difficultyDropdown.addDifficulty')}
            </button>
          )}

          {activeDifficulties.map((d) => {
            const name = nameFor(d);
            const isSelected = d.id === selectedId;
            // Rename/delete operate on the decrypted name (rename re-encrypts it,
            // the delete dialog displays it), so only enable them once a real
            // decrypted name exists — never on the locked/failed-decrypt
            // "🔒 Encrypted Difficulty" placeholder. Mirrors the download guard.
            const hasRealName = unlocked && names[d.id] !== undefined;
            return (
              <div
                key={d.id}
                className={`flex items-center justify-between gap-2 px-3 py-2 transition-colors ${
                  isSelected ? 'bg-blue-600/20' : 'hover:bg-gray-750'
                }`}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => { onSelect(d.id); setOpen(false); }}
                  className={`flex-1 min-w-0 text-left text-sm font-medium truncate ${
                    isSelected ? 'text-white' : 'text-gray-300'
                  }`}
                >
                  {name}
                </button>
                {isOwner && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={!hasRealName}
                      onClick={() => { onRenameDifficulty(d.id, name); setOpen(false); }}
                      aria-label={`${t('mapsetPage.renameDifficulty')}: ${name}`}
                      title={t('mapsetPage.renameDifficulty')}
                      className={ICON_BTN}
                    >
                      <PenIcon />
                    </button>
                    <button
                      type="button"
                      disabled={!hasRealName}
                      onClick={() => { onDeleteDifficulty(d.id, name); setOpen(false); }}
                      aria-label={`${t('mapsetPage.deleteDifficulty')}: ${name}`}
                      title={t('mapsetPage.deleteDifficulty')}
                      className={`${ICON_BTN} hover:text-red-400`}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {isOwner && pendingDifficulties.length > 0 && (
            <>
              <div className="my-1 border-t border-gray-700" />
              <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                {t('difficultyDropdown.deletedHeading')}
              </p>
              {pendingDifficulties.map((d) => {
                const name = nameFor(d);
                const isRestoring = restoringId === d.id;
                const isDownloading = downloadingId === d.id;
                const daysLeft = daysUntilPurge(d.delete_at);
                const expiryLabel =
                  daysLeft === null
                    ? t('mapsetPage.pendingExpiresUnknown')
                    : daysLeft === 0
                    ? t('mapsetPage.pendingExpiresImminent')
                    : t('mapsetPage.pendingExpiresInDays', { count: daysLeft });
                return (
                  <div key={d.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="flex flex-1 min-w-0 items-baseline gap-2">
                      <span className="truncate text-sm font-medium text-gray-400 line-through">
                        {name}
                      </span>
                      <span className="shrink-0 text-xs text-gray-500">{expiryLabel}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onDownloadDifficulty(d.id, name)}
                        disabled={isDownloading || !unlocked}
                        aria-label={`${t('mapsetPage.downloadOsu')}: ${name}`}
                        title={t('mapsetPage.downloadOsu')}
                        className={ICON_BTN}
                      >
                        <DownloadIcon />
                      </button>
                      <button
                        type="button"
                        onClick={() => onRestoreDifficulty(d.id)}
                        disabled={isRestoring}
                        aria-label={`${t('mapsetPage.restore')}: ${name}`}
                        title={t('mapsetPage.restore')}
                        className={`${ICON_BTN} hover:text-green-400`}
                      >
                        <RestoreIcon />
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {activeDifficulties.length === 0 && !canAdd && (
            <p className="px-3 py-2 text-sm italic text-gray-500">
              {t('difficultyTabs.noDifficulties')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
