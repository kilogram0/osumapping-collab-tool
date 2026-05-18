import { useMemo, useState } from 'react';
import { useEncryption } from '../contexts/EncryptionContext';
import { encrypt, sectionFieldAad } from '../utils/crypto';
import { useCreateSection } from '../hooks/useDifficulty';
import { formatTimestamp, parseTimestampString } from '../utils/extractTimestamp';

interface PreviousSection {
  id: string;
  endTimeMs: number;
  sortOrder: number;
}

interface CreateSectionModalProps {
  difficultyId: string;
  mapsetId: string;
  previousSections?: PreviousSection[];
  songLengthMs?: number | null;
  onSuccess: () => void;
  onCancel: () => void;
}

export default function CreateSectionModal({
  difficultyId,
  mapsetId,
  previousSections = [],
  songLengthMs,
  onSuccess,
  onCancel,
}: CreateSectionModalProps) {
  const { getKey } = useEncryption();
  const createSection = useCreateSection(difficultyId);

  const startMs = useMemo(() => {
    if (previousSections.length === 0) return 0;
    return Math.max(...previousSections.map((s) => s.endTimeMs));
  }, [previousSections]);

  const [name, setName] = useState('');
  const [endTimeInput, setEndTimeInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    setSubmitting(true);

    try {
      const key = await getKey(mapsetId);
      if (!key) {
        setError('Encryption key not found. Please unlock the mapset first.');
        setSubmitting(false);
        return;
      }

      const parsed = parseTimestampString(endTimeInput);
      if (!parsed) {
        setError('Invalid end time format. Use MM:SS:MMM (e.g. 00:30:000).');
        setSubmitting(false);
        return;
      }

      const endMs = parsed.ms;

      if (endMs < startMs + 1000) {
        setError(
          `End time must be at least 1 second after the automatically computed start time (${formatTimestamp(startMs)}).`,
        );
        setSubmitting(false);
        return;
      }

      if (songLengthMs !== null && songLengthMs !== undefined && endMs > songLengthMs) {
        setError(
          `End time may not exceed the song length (${formatTimestamp(songLengthMs)}).`,
        );
        setSubmitting(false);
        return;
      }

      const id = crypto.randomUUID();
      const order =
        previousSections.length === 0
          ? 0
          : Math.max(...previousSections.map((s) => s.sortOrder)) + 1;

      const [encryptedName, encryptedStart, encryptedEnd, encryptedSort] = await Promise.all([
        encrypt(key, name.trim(), sectionFieldAad(id, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: startMs }), sectionFieldAad(id, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: endMs }), sectionFieldAad(id, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: order }), sectionFieldAad(id, mapsetId)),
      ]);

      await createSection.mutateAsync({
        id,
        encrypted_name: encryptedName,
        encrypted_start_time_ms: encryptedStart,
        encrypted_end_time_ms: encryptedEnd,
        encrypted_sort_order: encryptedSort,
      });

      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create section';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-section-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-full max-w-md shadow-xl max-h-[90vh] overflow-y-auto">
        <h2 id="create-section-title" className="text-xl font-bold text-white mb-4">
          Add Section
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="section-name" className="block text-sm font-medium text-gray-300 mb-1">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              id="section-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={255}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              placeholder="e.g. Kiai 1"
            />
          </div>

          <div>
            <span className="block text-sm font-medium text-gray-300 mb-1">Start Time</span>
            <p className="text-sm text-gray-400">
              {formatTimestamp(startMs)} <span className="text-xs text-gray-500">(computed automatically from previous section)</span>
            </p>
          </div>

          <div>
            <label htmlFor="section-end-time" className="block text-sm font-medium text-gray-300 mb-1">
              End Time <span className="text-red-400">*</span>
            </label>
            <input
              id="section-end-time"
              type="text"
              value={endTimeInput}
              onChange={(e) => setEndTimeInput(e.target.value)}
              required
              placeholder="00:30:000"
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">Format: MM:SS:MMM (e.g. 01:15:250)</p>
          </div>

          {error && (
            <p role="alert" className="text-red-400 text-sm">
              {error}
            </p>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-gray-300 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || submitting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded transition-colors"
            >
              {submitting ? 'Creating…' : 'Add Section'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
