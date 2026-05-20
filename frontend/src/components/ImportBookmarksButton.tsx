import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useEncryption } from '../contexts/EncryptionContext';
import { parseOsuFile, MAX_OSU_BYTES } from '../utils/osuParser';
import { importSectionsFromBookmarks } from '../utils/importSectionsFromBookmarks';
import { fetchBaseOsuVersions } from '../api/endpoints';
import type { DecryptedSection } from './SectionList';

interface ImportBookmarksButtonProps {
  difficultyId: string;
  mapsetId: string;
  existingSections: DecryptedSection[];
  songLengthMs: number | null;
  onSuccess: (count: number, prepopulated: boolean) => void;
  onError: (message: string) => void;
}

export default function ImportBookmarksButton({
  difficultyId,
  mapsetId,
  existingSections,
  songLengthMs,
  onSuccess,
  onError,
}: ImportBookmarksButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const { getKey } = useEncryption();
  const queryClient = useQueryClient();

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (file.size > MAX_OSU_BYTES) {
      onError(`File too large (${file.size} bytes; max ${MAX_OSU_BYTES}).`);
      return;
    }

    setImporting(true);
    try {
      const text = await file.text();
      const parsed = parseOsuFile(text);

      const key = await getKey(mapsetId);
      if (!key) {
        onError('Encryption key not found. Please unlock the mapset first.');
        return;
      }

      // Pre-populate only when **no** base history exists. Checking just the
      // active base would let a user re-activate an older base after import
      // and find sections that disagree with it. We list the full history.
      const baseHistory = await fetchBaseOsuVersions(difficultyId);
      const canPrepopulate = baseHistory.length === 0;

      const startingSortOrder = existingSections.length === 0
        ? 0
        : Math.max(...existingSections.map((s) => s.sortOrder)) + 1;

      const result = await importSectionsFromBookmarks({
        parsed,
        key,
        mapsetId,
        difficultyId,
        songLengthMs,
        prepopulate: canPrepopulate,
        startingSortOrder,
      });

      // Refresh the cached section list / difficulty detail so the new
      // sections appear without a manual reload. Done by the caller because
      // the helper doesn't know about react-query.
      queryClient.invalidateQueries({ queryKey: ['sections', difficultyId] });
      queryClient.invalidateQueries({ queryKey: ['difficulty-detail', difficultyId] });

      if (result.error) {
        onError(
          result.created > 0
            ? `Imported ${result.created} of ${result.total} sections before failing: ${result.error}`
            : result.error,
        );
        return;
      }

      onSuccess(result.created, canPrepopulate);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to import bookmarks.');
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
        aria-label="Import sections from .osu bookmarks"
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={importing}
        className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors"
      >
        {importing ? 'Importing…' : 'Import Bookmarks'}
      </button>
    </>
  );
}
