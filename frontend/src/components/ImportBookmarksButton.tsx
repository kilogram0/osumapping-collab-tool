import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useEncryption } from '../contexts/EncryptionContext';
import { parseOsuFile, MAX_OSU_BYTES } from '../utils/osuParser';
import { importSectionsFromBookmarks } from '../utils/importSectionsFromBookmarks';
import { resectionFromBookmarks } from '../utils/resectionFromBookmarks';
import { fetchBaseOsuVersions } from '../api/endpoints';
import type { DecryptedSection } from './SectionList';

interface ImportBookmarksButtonProps {
  difficultyId: string;
  mapsetId: string;
  existingSections: DecryptedSection[];
  songLengthMs: number | null;
  onSuccess: (count: number, prepopulated: boolean) => void;
  /** Called after a successful re-section (the difficulty already had sections,
   *  so the layout was rebuilt rather than appended). */
  onResection?: (created: number) => void;
  onError: (message: string) => void;
  /** Render as a compact icon button instead of a labelled button. */
  iconOnly?: boolean;
}

function BookIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3.5h4a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 0 7 10.5H3z" />
      <path d="M13 3.5H9A1.5 1.5 0 0 0 7.5 5v7A1.5 1.5 0 0 1 9 10.5h4z" />
    </svg>
  );
}

export default function ImportBookmarksButton({
  difficultyId,
  mapsetId,
  existingSections,
  songLengthMs,
  onSuccess,
  onResection,
  onError,
  iconOnly = false,
}: ImportBookmarksButtonProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const { getKey } = useEncryption();
  const queryClient = useQueryClient();

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (file.size > MAX_OSU_BYTES) {
      onError(t('importBookmarks.fileTooLarge', { size: file.size, max: MAX_OSU_BYTES }));
      return;
    }

    setImporting(true);
    try {
      const text = await file.text();
      const parsed = parseOsuFile(text);

      const key = await getKey(mapsetId);
      if (!key) {
        onError(t('importBookmarks.errorKeyMissing'));
        return;
      }

      // A difficulty that already has sections must be *re-sectioned*, not
      // appended to — appending would stack a second overlapping layer of
      // sections and double-count objects on merge. Re-sectioning is
      // destructive (it removes the current sections), so confirm first.
      if (existingSections.length > 0) {
        const ok = window.confirm(
          t('importBookmarks.resectionConfirm', { count: existingSections.length }),
        );
        if (!ok) return;

        const result = await resectionFromBookmarks({
          parsed,
          key,
          mapsetId,
          difficultyId,
          songLengthMs,
          existingSections: existingSections.map((s) => ({
            id: s.id,
            sortOrder: s.sortOrder,
            endTimeMs: s.endTimeMs,
          })),
        });

        queryClient.invalidateQueries({ queryKey: ['sections', difficultyId] });
        queryClient.invalidateQueries({ queryKey: ['difficulty-detail', difficultyId] });

        if (result.error) {
          onError(
            result.created > 0
              ? t('importBookmarks.resectionPartial', { created: result.created, total: result.total, message: result.error })
              : result.error,
          );
          return;
        }

        onResection?.(result.created);
        return;
      }

      // Pre-populate only when **no** base history exists. Checking just the
      // active base would let a user re-activate an older base after import
      // and find sections that disagree with it. We list the full history.
      const baseHistory = await fetchBaseOsuVersions(difficultyId);
      const canPrepopulate = baseHistory.length === 0;

      const result = await importSectionsFromBookmarks({
        parsed,
        key,
        mapsetId,
        difficultyId,
        songLengthMs,
        prepopulate: canPrepopulate,
        startingSortOrder: 0,
      });

      // Refresh the cached section list / difficulty detail so the new
      // sections appear without a manual reload. Done by the caller because
      // the helper doesn't know about react-query.
      queryClient.invalidateQueries({ queryKey: ['sections', difficultyId] });
      queryClient.invalidateQueries({ queryKey: ['difficulty-detail', difficultyId] });

      if (result.error) {
        onError(
          result.created > 0
            ? t('importBookmarks.partial', { created: result.created, total: result.total, message: result.error })
            : result.error,
        );
        return;
      }

      onSuccess(result.created, canPrepopulate);
    } catch (err) {
      onError(err instanceof Error ? err.message : t('importBookmarks.errorGeneric'));
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".osu"
        className="hidden"
        onChange={handleFileSelect}
        aria-label={t('importBookmarks.ariaLabel')}
      />
      {iconOnly ? (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          aria-label={t('importBookmarks.button')}
          title={importing ? t('importBookmarks.importing') : t('importBookmarks.button')}
          className="px-4 py-3.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
        >
          <BookIcon />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors"
        >
          {importing ? t('importBookmarks.importing') : t('importBookmarks.button')}
        </button>
      )}
    </>
  );
}
