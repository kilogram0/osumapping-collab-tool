import { useEffect, useState } from 'react';
import { useEncryption } from '../contexts/EncryptionContext';
import { encrypt, sectionFieldAad } from '../utils/crypto';
import { useCreateSection } from '../hooks/useDifficulty';
import { msToParts } from '../utils/timeInput';
import TimeInput from './TimeInput';

interface PreviousSection {
  id: string;
  endTimeMs: number;
}

interface CreateSectionModalProps {
  difficultyId: string;
  mapsetId: string;
  previousSections?: PreviousSection[];
  onSuccess: () => void;
  onCancel: () => void;
}

export default function CreateSectionModal({
  difficultyId,
  mapsetId,
  previousSections = [],
  onSuccess,
  onCancel,
}: CreateSectionModalProps) {
  const { getKey } = useEncryption();
  const createSection = useCreateSection(difficultyId);

  const maxEndTime = previousSections.length > 0
    ? Math.max(...previousSections.map((s) => s.endTimeMs))
    : 0;
  const defaultStart = msToParts(maxEndTime);

  const [name, setName] = useState('');
  const [startMinutes, setStartMinutes] = useState(defaultStart.minutes);
  const [startSeconds, setStartSeconds] = useState(defaultStart.seconds);
  const [startMillis, setStartMillis] = useState(defaultStart.millis);
  const [endMinutes, setEndMinutes] = useState('');
  const [endSeconds, setEndSeconds] = useState('');
  const [endMillis, setEndMillis] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const start = msToParts(maxEndTime);
    setStartMinutes(start.minutes);
    setStartSeconds(start.seconds);
    setStartMillis(start.millis);
  }, [maxEndTime]);

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

      const startMs =
        (Number(startMinutes) || 0) * 60_000 +
        (Number(startSeconds) || 0) * 1_000 +
        (Number(startMillis) || 0);
      const endMs =
        (Number(endMinutes) || 0) * 60_000 +
        (Number(endSeconds) || 0) * 1_000 +
        (Number(endMillis) || 0);

      if (endMs <= startMs) {
        setError('End time must be after start time.');
        setSubmitting(false);
        return;
      }

      const id = crypto.randomUUID();

      // NOTE: encrypted_sort_order is legacy.  The frontend now sorts sections
      // by start_time_ms, so sort_order is always 0.  We still encrypt and
      // send it because the DB column is NOT NULL; a future migration can
      // drop the column and remove this field.
      const order = 0;

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

          <TimeInput
            label="Start Time"
            minutesId="section-start-min"
            secondsId="section-start-sec"
            millisId="section-start-ms"
            minutes={startMinutes}
            seconds={startSeconds}
            millis={startMillis}
            onChangeMinutes={setStartMinutes}
            onChangeSeconds={setStartSeconds}
            onChangeMillis={setStartMillis}
          />

          <TimeInput
            label="End Time"
            minutesId="section-end-min"
            secondsId="section-end-sec"
            millisId="section-end-ms"
            minutes={endMinutes}
            seconds={endSeconds}
            millis={endMillis}
            onChangeMinutes={setEndMinutes}
            onChangeSeconds={setEndSeconds}
            onChangeMillis={setEndMillis}
          />

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
