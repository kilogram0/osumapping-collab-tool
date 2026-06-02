import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchPin, type DifficultyPin, type Section } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { useToast } from '../contexts/ToastContext';
import { usePins, useCreatePin, useDeletePin } from '../hooks/usePins';
import {
  decrypt,
  decodeJsonEnvelope,
  encrypt,
  difficultyPinAad,
  sectionFieldAad,
} from '../utils/crypto';
import { assembleFullOsu } from '../utils/sectionDownload';
import { parseOsuFile, withMetadataVersion } from '../utils/osuParser';
import { composeOsuFilename } from '../utils/osuFilename';
import { logger } from '../utils/logger';

interface PinButtonProps {
  difficultyId: string;
  mapsetId: string;
  mapsetTitle: string;
  sections: Section[];
  difficultyName?: string | null;
  /** Owners may create and delete pins; everyone else is view/download only. */
  isOwner: boolean;
  /** Resolve a creator's user id to a display name for the pin list. */
  resolveUsername: (userId: string) => string | undefined;
}

function PinIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 9.5V14M5 2.5h6l-.5 4 2 2.5H3.5l2-2.5-.5-4Z" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/** Trigger a browser download of text as an .osu file. */
function saveOsu(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Default pin label: `v.DD.MM.YY` (the day this pin is created). */
function defaultPinName(now = new Date()): string {
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yy = String(now.getFullYear() % 100).padStart(2, '0');
  return `v.${dd}.${mm}.${yy}`;
}

export default function PinButton({
  difficultyId,
  mapsetId,
  mapsetTitle,
  sections,
  difficultyName,
  isOwner,
  resolveUsername,
}: PinButtonProps) {
  const { t } = useTranslation();
  const { isUnlocked, getKey } = useEncryption();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showList, setShowList] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const unlocked = isUnlocked(mapsetId);
  const hasSections = sections.length > 0;

  // Close the dropdown on outside click / Escape.
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

  const menuId = `pin-menu-${difficultyId}`;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!unlocked}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t('pin.button')}
        title={!unlocked ? t('pin.titleLocked') : t('pin.button')}
        className="inline-flex items-center gap-1.5 px-4 py-3.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
      >
        <PinIcon />
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t('pin.menuLabel')}
          className="absolute right-0 z-30 mt-1 min-w-full whitespace-nowrap rounded-lg border border-gray-700 bg-gray-800 shadow-xl py-1"
        >
          {isOwner && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); setShowCreate(true); }}
              disabled={!hasSections}
              title={!hasSections ? t('pin.titleEmpty') : undefined}
              className="block w-full px-4 py-2 text-left text-sm text-white hover:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
            >
              {t('pin.optionPinVersion')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); setShowList(true); }}
            className="block w-full px-4 py-2 text-left text-sm text-white hover:bg-gray-700 transition-colors"
          >
            {t('pin.optionViewPins')}
          </button>
        </div>
      )}

      {showCreate && (
        <CreatePinModal
          difficultyId={difficultyId}
          mapsetId={mapsetId}
          sections={sections}
          getKey={getKey}
          onClose={() => setShowCreate(false)}
          onSuccess={() => { setShowCreate(false); showToast(t('pin.success'), 'success'); }}
        />
      )}

      {showList && (
        <PinListModal
          difficultyId={difficultyId}
          mapsetId={mapsetId}
          mapsetTitle={mapsetTitle}
          difficultyName={difficultyName}
          isOwner={isOwner}
          getKey={getKey}
          resolveUsername={resolveUsername}
          onClose={() => setShowList(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create pin modal
// ---------------------------------------------------------------------------

interface CreatePinModalProps {
  difficultyId: string;
  mapsetId: string;
  sections: Section[];
  getKey: (mapsetId: string) => Promise<CryptoKey | null>;
  onClose: () => void;
  onSuccess: () => void;
}

function CreatePinModal({ difficultyId, mapsetId, sections, getKey, onClose, onSuccess }: CreatePinModalProps) {
  const { t } = useTranslation();
  const createPinMutation = useCreatePin(difficultyId);
  const [name, setName] = useState(() => defaultPinName());
  const [error, setError] = useState<string | null>(null);
  const submitting = createPinMutation.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const label = name.trim();
    if (!label) { setError(t('pin.errorEmptyName')); return; }
    if (sections.length === 0) { setError(t('pin.errorNoSections')); return; }
    setError(null);

    try {
      const key = await getKey(mapsetId);
      if (!key) { setError(t('pin.errorKeyMissing')); return; }

      // Decrypt each section's sortOrder + endTimeMs so the assembler can order
      // and clip sections — same inputs MergedDownloadButton's full-diff uses.
      // Unlike the transient full-diff download, a pin is an immutable archival
      // snapshot, so a single section that fails to decrypt aborts the whole pin
      // rather than silently persisting an incomplete "fully-assembled" .osu.
      const sectionMeta: { id: string; sortOrder: number; endTimeMs: number }[] = [];
      for (const section of sections) {
        try {
          const aad = sectionFieldAad(section.id, mapsetId);
          const [sortOrderRaw, endRaw] = await Promise.all([
            decrypt(key, section.encrypted_sort_order, aad),
            decrypt(key, section.encrypted_end_time_ms, aad),
          ]);
          sectionMeta.push({
            id: section.id,
            sortOrder: decodeJsonEnvelope(sortOrderRaw),
            endTimeMs: decodeJsonEnvelope(endRaw),
          });
        } catch (err) {
          logger.warn(`Failed to decrypt section ${section.id} for pin:`, err);
          setError(t('pin.errorSectionDecrypt'));
          return;
        }
      }

      const { content } = await assembleFullOsu({ difficultyId, mapsetId, key, sections: sectionMeta });

      const pinId = crypto.randomUUID();
      const aad = difficultyPinAad(pinId, mapsetId);
      const [encryptedContent, encryptedLabel] = await Promise.all([
        encrypt(key, content, aad),
        encrypt(key, label, aad),
      ]);

      await createPinMutation.mutateAsync({
        id: pinId,
        encrypted_label: encryptedLabel,
        encrypted_content: encryptedContent,
      });
      onSuccess();
    } catch (err) {
      logger.warn('Failed to create pin:', err);
      setError(err instanceof Error ? err.message : t('pin.errorFailed'));
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-pin-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    >
      <form
        onSubmit={handleSubmit}
        className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-full max-w-sm shadow-xl"
      >
        <h2 id="create-pin-title" className="text-lg font-bold text-white mb-2">{t('pin.createTitle')}</h2>
        <p className="text-sm text-gray-400 mb-4">{t('pin.createDescription')}</p>
        <label className="block text-sm text-gray-300 mb-1" htmlFor="pin-name-input">{t('pin.nameLabel')}</label>
        <input
          id="pin-name-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('pin.namePlaceholder')}
          autoFocus
          disabled={submitting}
          className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white text-sm mb-3 focus:outline-none focus:border-blue-500"
        />
        {error && <p role="alert" className="text-sm text-red-400 mb-3">{error}</p>}
        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-gray-300 hover:text-white transition-colors disabled:opacity-50"
          >
            {t('pin.close')}
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
          >
            {submitting ? t('pin.pinning') : t('pin.create')}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pin list modal
// ---------------------------------------------------------------------------

interface PinListModalProps {
  difficultyId: string;
  mapsetId: string;
  mapsetTitle: string;
  difficultyName?: string | null;
  isOwner: boolean;
  getKey: (mapsetId: string) => Promise<CryptoKey | null>;
  resolveUsername: (userId: string) => string | undefined;
  onClose: () => void;
}

function PinListModal({
  difficultyId, mapsetId, mapsetTitle, difficultyName, isOwner, getKey, resolveUsername, onClose,
}: PinListModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { data: pins, isLoading } = usePins(difficultyId);
  const deletePinMutation = useDeletePin(difficultyId);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Decrypt pin labels whenever the list changes.
  useEffect(() => {
    if (!pins?.length) { setLabels({}); return; }
    let cancelled = false;
    (async () => {
      const key = await getKey(mapsetId);
      if (!key || cancelled) return;
      const next: Record<string, string> = {};
      await Promise.all(pins.map(async (pin) => {
        try {
          next[pin.id] = await decrypt(key, pin.encrypted_label, difficultyPinAad(pin.id, mapsetId));
        } catch (err) {
          logger.warn(`Failed to decrypt pin label ${pin.id}:`, err);
          next[pin.id] = t('pin.decryptFailed');
        }
      }));
      if (!cancelled) setLabels(next);
    })();
    return () => { cancelled = true; };
  }, [pins, mapsetId, getKey, t]);

  // The API already returns pins newest-first (order_by created_at desc), so no
  // client-side re-sort is needed.
  const sortedPins = pins ?? [];

  async function handleDownload(pin: DifficultyPin) {
    setDownloadingId(pin.id);
    try {
      const key = await getKey(mapsetId);
      if (!key) { showToast(t('pin.errorKeyMissing'), 'error'); return; }
      const full = await fetchPin(difficultyId, pin.id);
      const plaintext = await decrypt(key, full.encrypted_content, difficultyPinAad(pin.id, mapsetId));
      const label = labels[pin.id] ?? 'pin';
      // Stamp the pin label into [Metadata] Version so the editor + filename match.
      const { content, metadata } = withMetadataVersion(parseOsuFile(plaintext), label);
      const filename = composeOsuFilename({
        artist: metadata.artist,
        title: metadata.title,
        mapsetTitle,
        diffName: difficultyName ? `${difficultyName}_${label}` : label,
      });
      saveOsu(content, filename);
    } catch (err) {
      logger.warn('Failed to download pin:', err);
      showToast(t('pin.downloadFailed'), 'error');
    } finally {
      setDownloadingId(null);
    }
  }

  async function handleDelete(pin: DifficultyPin) {
    if (!confirm(t('pin.deleteConfirm'))) return;
    setDeletingId(pin.id);
    try {
      await deletePinMutation.mutateAsync(pin.id);
      showToast(t('pin.deleteSuccess'), 'success');
    } catch (err) {
      logger.warn('Failed to delete pin:', err);
      showToast(t('pin.deleteFailed'), 'error');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-list-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    >
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-full max-w-md shadow-xl max-h-[80vh] flex flex-col">
        <h2 id="pin-list-title" className="text-lg font-bold text-white mb-4">{t('pin.listTitle')}</h2>

        <div className="flex-1 overflow-y-auto -mx-2 px-2">
          {isLoading && <p className="text-gray-400 text-sm">{t('pin.listLoading')}</p>}
          {!isLoading && sortedPins.length === 0 && (
            <p className="text-gray-400 italic text-sm">{t('pin.listEmpty')}</p>
          )}
          <ul className="space-y-2">
            {sortedPins.map((pin) => (
              <li
                key={pin.id}
                className="flex items-center justify-between gap-3 bg-gray-900 border border-gray-700 rounded p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm text-white font-medium truncate">
                    {labels[pin.id] ?? '…'}
                  </p>
                  <p className="text-xs text-gray-400 truncate">
                    {t('pin.createdByPrefix')}{resolveUsername(pin.created_by) ?? pin.created_by}
                    {' · '}{new Date(pin.created_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleDownload(pin)}
                    disabled={downloadingId === pin.id}
                    className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-medium rounded transition-colors"
                  >
                    {downloadingId === pin.id ? t('pin.downloading') : t('pin.download')}
                  </button>
                  {isOwner && (
                    <button
                      type="button"
                      onClick={() => handleDelete(pin)}
                      disabled={deletingId === pin.id}
                      aria-label={t('pin.delete')}
                      title={t('pin.delete')}
                      className="px-3 py-1.5 bg-gray-700 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-medium rounded transition-colors"
                    >
                      {deletingId === pin.id ? t('pin.deleting') : t('pin.delete')}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex justify-end mt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-gray-300 hover:text-white transition-colors"
          >
            {t('pin.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
