import { useState } from 'react';
import { useEncryption } from '../contexts/EncryptionContext';
import { encrypt, difficultyFieldAad } from '../utils/crypto';
import { useCreateDifficulty } from '../hooks/useDifficulty';

interface CreateDifficultyModalProps {
  mapsetId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export default function CreateDifficultyModal({ mapsetId, onSuccess, onCancel }: CreateDifficultyModalProps) {
  const { getKey } = useEncryption();
  const createDifficulty = useCreateDifficulty(mapsetId);

  const [name, setName] = useState('');
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

      const id = crypto.randomUUID();
      const encryptedName = await encrypt(key, name.trim(), difficultyFieldAad(id, mapsetId));

      await createDifficulty.mutateAsync({
        id,
        encrypted_name: encryptedName,
      });

      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create difficulty';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-difficulty-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-full max-w-md shadow-xl">
        <h2 id="create-difficulty-title" className="text-xl font-bold text-white mb-4">
          Add Difficulty
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="difficulty-name" className="block text-sm font-medium text-gray-300 mb-1">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              id="difficulty-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={255}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              placeholder="e.g. Hard"
            />
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
              {submitting ? 'Creating…' : 'Add Difficulty'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
