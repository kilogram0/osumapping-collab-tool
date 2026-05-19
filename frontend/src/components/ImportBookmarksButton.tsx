import { useRef, useState } from 'react';
import { useEncryption } from '../contexts/EncryptionContext';
import { encrypt, sectionFieldAad } from '../utils/crypto';
import { parseOsuFile, parseBookmarks, bookmarksToSectionBoundaries } from '../utils/osuParser';
import { useCreateSection } from '../hooks/useDifficulty';
import type { DecryptedSection } from './SectionList';

interface ImportBookmarksButtonProps {
  difficultyId: string;
  mapsetId: string;
  existingSections: DecryptedSection[];
  songLengthMs: number | null;
  onSuccess: (count: number) => void;
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
  const createSection = useCreateSection(difficultyId);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setImporting(true);
    try {
      const text = await file.text();
      const parsed = parseOsuFile(text);
      const bookmarks = parseBookmarks(parsed);

      if (bookmarks.length === 0) {
        onError('No bookmarks found in the [Editor] section of this .osu file.');
        return;
      }

      const boundaries = bookmarksToSectionBoundaries(bookmarks, songLengthMs);
      if (boundaries.length === 0) {
        onError('Could not derive any sections from the bookmarks.');
        return;
      }

      const key = await getKey(mapsetId);
      if (!key) {
        onError('Encryption key not found. Please unlock the mapset first.');
        return;
      }

      const baseOrder = existingSections.length === 0
        ? 0
        : Math.max(...existingSections.map((s) => s.sortOrder)) + 1;

      let succeeded = 0;
      for (let i = 0; i < boundaries.length; i++) {
        const { startMs, endMs } = boundaries[i];
        const id = crypto.randomUUID();
        const order = baseOrder + i;
        // Name uses the bookmark index, not order. Sort_order can later
        // diverge via reordering, but the imported name should remain stable.
        const name = `Imported section ${i + 1}`;

        try {
          const [encName, encStart, encEnd, encSort] = await Promise.all([
            encrypt(key, name, sectionFieldAad(id, mapsetId)),
            encrypt(key, JSON.stringify({ v: 0, ms: startMs }), sectionFieldAad(id, mapsetId)),
            encrypt(key, JSON.stringify({ v: 0, ms: endMs }), sectionFieldAad(id, mapsetId)),
            encrypt(key, JSON.stringify({ v: 0, ms: order }), sectionFieldAad(id, mapsetId)),
          ]);

          await createSection.mutateAsync({
            id,
            encrypted_name: encName,
            encrypted_start_time_ms: encStart,
            encrypted_end_time_ms: encEnd,
            encrypted_sort_order: encSort,
          });
          succeeded++;
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to create section';
          onError(
            succeeded > 0
              ? `Imported ${succeeded} of ${boundaries.length} sections before failing: ${message}`
              : `Failed to import sections: ${message}`,
          );
          return;
        }
      }

      onSuccess(succeeded);
    } catch (err) {
      // Reached only when parsing/key-resolution fails before the loop runs.
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
