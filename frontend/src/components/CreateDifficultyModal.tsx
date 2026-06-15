import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useEncryption } from '../contexts/EncryptionContext';
import { useToast } from '../contexts/ToastContext';
import { encrypt, difficultyFieldAad } from '../utils/crypto';
import { useCreateDifficulty } from '../hooks/useDifficulty';
import {
  parseOsuFile,
  parseDifficultyName,
  MAX_OSU_BYTES,
  type ParsedOsuFile,
} from '../utils/osuParser';
import { importSectionsFromBookmarks } from '../utils/importSectionsFromBookmarks';
import { Button, Input, Modal } from './ui';

interface CreateDifficultyModalProps {
  mapsetId: string;
  songLengthMs?: number | null;
  onSuccess: (newDifficultyId: string) => void;
  onCancel: () => void;
}

export default function CreateDifficultyModal({
  mapsetId,
  songLengthMs,
  onSuccess,
  onCancel,
}: CreateDifficultyModalProps) {
  const { t } = useTranslation();
  const { getKey } = useEncryption();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const createDifficulty = useCreateDifficulty(mapsetId);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [osuFile, setOsuFile] = useState<File | null>(null);
  // Cache the parsed file from handleFileChange so importBookmarks doesn't
  // have to re-read + re-parse on submit.
  const [parsedOsu, setParsedOsu] = useState<ParsedOsuFile | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setParseError(null);
    if (!f) {
      setOsuFile(null);
      setParsedOsu(null);
      return;
    }
    if (f.size > MAX_OSU_BYTES) {
      setOsuFile(null);
      setParsedOsu(null);
      setParseError(t('createDifficultyModal.fileTooLarge', { size: f.size, max: MAX_OSU_BYTES }));
      e.target.value = '';
      return;
    }
    // Eager-validate so the user sees the size/format problem before submit.
    try {
      const text = await f.text();
      const parsed = parseOsuFile(text);
      setOsuFile(f);
      setParsedOsu(parsed);
      // If the user hasn't typed a name yet, derive one from the .osu's
      // [Metadata] Version field. Don't overwrite an explicit name.
      const derived = parseDifficultyName(parsed);
      if (derived && !name.trim()) {
        setName(derived);
      }
    } catch (err) {
      setOsuFile(null);
      setParsedOsu(null);
      setParseError(err instanceof Error ? err.message : t('createDifficultyModal.errorInvalidOsu'));
      e.target.value = '';
    }
  }

  /** Delegates to the shared {@link importSectionsFromBookmarks} helper.
   *  Brand-new difficulty in this submit → no base history → prepopulate=true
   *  is unconditionally safe. */
  async function importBookmarks(
    key: CryptoKey,
    difficultyId: string,
  ): Promise<{ created: number; total: number; error: string | null }> {
    if (!parsedOsu) return { created: 0, total: 0, error: null };
    return importSectionsFromBookmarks({
      parsed: parsedOsu,
      key,
      mapsetId,
      difficultyId,
      songLengthMs: songLengthMs ?? null,
      prepopulate: true,
      startingSortOrder: 0,
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    setSubmitting(true);

    let newDifficultyId: string | null = null;
    try {
      const key = await getKey(mapsetId);
      if (!key) {
        setError(t('createDifficultyModal.errorKeyMissing'));
        setSubmitting(false);
        return;
      }

      const id = crypto.randomUUID();
      const encryptedName = await encrypt(key, name.trim(), difficultyFieldAad(id, mapsetId));

      await createDifficulty.mutateAsync({
        id,
        encrypted_name: encryptedName,
      });
      newDifficultyId = id;

      // Difficulty creation succeeded. If a .osu file is attached, run the
      // bookmark import against the new difficulty. Failures here are toasted
      // but do not roll back the difficulty (the user can retry via the
      // standalone Import Bookmarks button afterwards).
      if (osuFile) {
        const result = await importBookmarks(key, id);
        if (result.error) {
          if (result.created > 0) {
            showToast(
              t('createDifficultyModal.toastBookmarkPartial', { created: result.created, total: result.total, message: result.error }),
              'warning',
            );
          } else {
            showToast(t('createDifficultyModal.toastBookmarkFailure', { message: result.error }), 'warning');
          }
        } else {
          showToast(t('createDifficultyModal.toastBookmarkOk', { count: result.created }), 'success');
        }
        queryClient.invalidateQueries({ queryKey: ['sections', id] });
        queryClient.invalidateQueries({ queryKey: ['difficulty-detail', id] });
      } else {
        showToast(t('createDifficultyModal.toastDifficultyCreated'), 'success');
      }

      onSuccess(newDifficultyId);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('createDifficultyModal.errorGeneric');
      if (newDifficultyId) {
        showToast(t('createDifficultyModal.toastFollowupFailed', { message }), 'warning');
        onSuccess(newDifficultyId);
      } else {
        setError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open ariaLabelledBy="create-difficulty-title" onClose={onCancel}>
      <div className="p-6">
        <h2 id="create-difficulty-title" className="text-xl font-bold text-white mb-4">
          {t('createDifficultyModal.title')}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            id="difficulty-name"
            label={t('createDifficultyModal.nameLabel')}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={255}
            placeholder={t('createDifficultyModal.namePlaceholder')}
          />

          <div>
            <label htmlFor="difficulty-osu" className="block text-sm font-medium text-muted-light mb-1">
              {t('createDifficultyModal.osuLabel')}
            </label>
            <input
              ref={fileInputRef}
              id="difficulty-osu"
              type="file"
              accept=".osu"
              onChange={handleFileChange}
              className="block w-full text-sm text-muted-light file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-purple-600 file:text-white hover:file:bg-purple-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-muted/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded"
            />
            <p className="text-xs text-muted mt-1">
              {t('createDifficultyModal.osuHelpPrefix')}<code>[Editor] Bookmarks</code>{t('createDifficultyModal.osuHelpSuffix')}
            </p>
            {osuFile && !parseError && (
              <p className="text-xs text-success-muted mt-1">{t('createDifficultyModal.selectedFile', { name: osuFile.name })}</p>
            )}
            {parseError && (
              <p role="alert" className="text-xs text-danger-muted mt-1">{parseError}</p>
            )}
          </div>

          {error && (
            <p role="alert" className="text-danger-muted text-sm">
              {error}
            </p>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim()} loading={submitting}>
              {submitting ? t('createDifficultyModal.submitting') : t('createDifficultyModal.submit')}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
