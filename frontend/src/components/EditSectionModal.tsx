import { useEffect, useState } from 'react';
import { useEncryption } from '../contexts/EncryptionContext';
import { encrypt, sectionFieldAad } from '../utils/crypto';
import { useUpdateSection } from '../hooks/useDifficulty';
import { msToParts } from '../utils/timeInput';
import TimeInput from './TimeInput';

interface EditSectionModalProps {
  difficultyId: string;
  mapsetId: string;
  sectionId: string;
  initialName: string;
  initialStartTimeMs: number;
  initialEndTimeMs: number;
  onSuccess: () => void;
  onCancel: () => void;
}

export default function EditSectionModal({
  difficultyId,
  mapsetId,
  sectionId,
  initialName,
  initialStartTimeMs,
  initialEndTimeMs,
  onSuccess,
  onCancel,
}: EditSectionModalProps) {
  const { getKey } = useEncryption();
  const updateSection = useUpdateSection(difficultyId);

  const startParts = msToParts(initialStartTimeMs);
  const endParts = msToParts(initialEndTimeMs);

  const [name, setName] = useState(initialName);
  const [startMinutes, setStartMinutes] = useState(startParts.minutes);
  const [startSeconds, setStartSeconds] = useState(startParts.seconds);
  const [startMillis, setStartMillis] = useState(startParts.millis);
  const [endMinutes, setEndMinutes] = useState(endParts.minutes);
  const [endSeconds, setEndSeconds] = useState(endParts.seconds);
  const [endMillis, setEndMillis] = useState(endParts.millis);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const s = msToParts(initialStartTimeMs);
    const e = msToParts(initialEndTimeMs);
    setName(initialName);
    setStartMinutes(s.minutes);
    setStartSeconds(s.seconds);
    setStartMillis(s.millis);
    setEndMinutes(e.minutes);
    setEndSeconds(e.seconds);
    setEndMillis(e.millis);
  }, [initialName, initialStartTimeMs, initialEndTimeMs]);

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

      const payload: Parameters<typeof updateSection.mutate>[0]['payload'] = {};

      payload.encrypted_name = await encrypt(key, name.trim(), sectionFieldAad(sectionId, mapsetId));
      payload.encrypted_start_time_ms = await encrypt(
        key,
        JSON.stringify({ v: 0, ms: startMs }),
        sectionFieldAad(sectionId, mapsetId),
      );
      payload.encrypted_end_time_ms = await encrypt(
        key,
        JSON.stringify({ v: 0, ms: endMs }),
        sectionFieldAad(sectionId, mapsetId),
      );

      await updateSection.mutateAsync({ sectionId, payload });

      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update section';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-section-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-full max-w-md shadow-xl max-h-[90vh] overflow-y-auto">
        <h2 id="edit-section-title" className="text-xl font-bold text-white mb-4">
          Edit Section
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="edit-section-name" className="block text-sm font-medium text-gray-300 mb-1">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              id="edit-section-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={255}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          <TimeInput
            label="Start Time"
            minutesId="edit-start-min"
            secondsId="edit-start-sec"
            millisId="edit-start-ms"
            minutes={startMinutes}
            seconds={startSeconds}
            millis={startMillis}
            onChangeMinutes={setStartMinutes}
            onChangeSeconds={setStartSeconds}
            onChangeMillis={setStartMillis}
          />

          <TimeInput
            label="End Time"
            minutesId="edit-end-min"
            secondsId="edit-end-sec"
            millisId="edit-end-ms"
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
              {submitting ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
