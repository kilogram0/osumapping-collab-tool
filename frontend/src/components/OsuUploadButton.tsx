import { useRef, useState, useCallback, useEffect } from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  uploadSectionOsu,
  downloadBaseOsu,
  type UploadSectionOsuPayload,
} from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { encrypt, decrypt, sectionOsuVersionAad, difficultyBaseOsuVersionAad } from '../utils/crypto';
import {
  parseOsuFile,
  buildCandidateBase,
  validateOsuFile,
  sanitizeSectionUpload,
  MAX_OSU_BYTES,
  type SectionFilterCounts,
} from '../utils/osuParser';
import { diffBase, type DiffReport, normalizeCriticalLines } from '../utils/osuBase';
import { logger } from '../utils/logger';

interface OsuUploadButtonProps {
  difficultyId: string;
  sectionId: string;
  mapsetId: string;
  role?: 'owner' | 'mapper' | 'modder' | null;
  /** Section time range [start, end). When omitted, the upload is not
   *  sanitized (legacy callers / tests). Both bounds must be present
   *  together — typing them as one object makes that all-or-nothing
   *  contract visible. */
  sectionRange?: { start: number; end: number };
  /** If set and differs from currentUserId, shows a "are you sure?" before uploading. */
  assignedToUserId?: string | null;
  currentUserId?: string;
  assignedToUsername?: string | null;
}

interface UploadState {
  loading: boolean;
  error: string | null;
  success: boolean;
  warning: string | null;
}

type ModalMode = 'owner-critical' | 'mapper-critical' | 'legacy' | 'sanitize';

export default function OsuUploadButton({
  difficultyId,
  sectionId,
  mapsetId,
  role,
  sectionRange,
  assignedToUserId,
  currentUserId,
  assignedToUsername,
}: OsuUploadButtonProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryClient = useQueryClient();
  const { isUnlocked, getKey } = useEncryption();
  const unlocked = isUnlocked(mapsetId);

  const [uploadState, setUploadState] = useState<UploadState>({
    loading: false,
    error: null,
    success: false,
    warning: null,
  });

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>('legacy');
  const [diffReport, setDiffReport] = useState<DiffReport | null>(null);
  const [normalizeCritical, setNormalizeCritical] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<{
    sectionContent: string;
    candidateBase: string;
    activeBase: string | null;
  } | null>(null);
  const [sanitizeReport, setSanitizeReport] = useState<SectionFilterCounts | null>(null);
  const [pendingSanitized, setPendingSanitized] = useState<{
    /** Original .osu text — used to compute the candidate base (keeps positive
     *  BPM timing points across the whole song, not just this section). */
    original: string;
    /** Sanitized .osu text — used as the section's encrypted_content. */
    sanitized: string;
  } | null>(null);

  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!modalOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        handleCancelModal();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [modalOpen]);

  const resetUploadState = useCallback(() => {
    setUploadState({ loading: false, error: null, success: false, warning: null });
  }, []);

  const performUpload = useCallback(
    async (key: CryptoKey, sectionContent: string, candidateBase: string | null): Promise<boolean> => {
      setUploadState({ loading: true, error: null, success: false, warning: null });

      try {
        const sectionVersionId = crypto.randomUUID();
        const encryptedSection = await encrypt(
          key,
          sectionContent,
          sectionOsuVersionAad(sectionVersionId, mapsetId),
        );

        const payload: UploadSectionOsuPayload = {
          id: sectionVersionId,
          encrypted_content: encryptedSection,
        };

        if (candidateBase !== null) {
          const baseVersionId = crypto.randomUUID();
          const encryptedBase = await encrypt(
            key,
            candidateBase,
            difficultyBaseOsuVersionAad(baseVersionId, mapsetId),
          );
          payload.base_version = {
            id: baseVersionId,
            encrypted_content: encryptedBase,
          };
        }

        await uploadSectionOsu(difficultyId, sectionId, payload);

        queryClient.invalidateQueries({ queryKey: ['sections', difficultyId] });
        queryClient.invalidateQueries({ queryKey: ['difficulties', difficultyId] });
        queryClient.invalidateQueries({ queryKey: ['section-osu-versions', difficultyId, sectionId] });
        queryClient.invalidateQueries({ queryKey: ['base-osu-versions', difficultyId] });

        setUploadState({ loading: false, error: null, success: true, warning: null });
        if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
        successTimeoutRef.current = setTimeout(() => setUploadState((s) => ({ ...s, success: false })), 3000);
        return true;
      } catch (err) {
        logger.warn('Upload failed:', err);
        const message = err instanceof Error ? err.message : t('osuUpload.errorUploadFailed');
        setUploadState({ loading: false, error: message, success: false, warning: null });
        return false;
      }
    },
    [difficultyId, sectionId, mapsetId, queryClient],
  );

  /**
   * Continue an upload after parsing and (if applicable) sanitizing.
   *
   * Two inputs because the candidate base and the section content come from
   * different sources:
   *   - candidateBase is derived from `originalText` (the full uploaded file)
   *     so positive BPM timing points across the whole song are preserved —
   *     the base is the song-wide trunk, not section-bounded.
   *   - sectionText is what gets encrypted into this section's content. It
   *     may have been trimmed to [startMs, endMs) by sanitizeSectionUpload.
   *
   * Conflating the two would strip BPM points outside the section's range
   * from the base, which the merged-download path then can't restore.
   */
  const proceedAfterSanitize = useCallback(
    async (originalText: string, sectionText: string) => {
      setUploadState({ loading: true, error: null, success: false, warning: null });
      try {
        const originalParsed = parseOsuFile(originalText);
        const candidateBase = buildCandidateBase(originalParsed);

        const key = await getKey(mapsetId);
        if (!key) {
          setUploadState({ loading: false, error: t('osuUpload.errorKeyMissing'), success: false, warning: null });
          return;
        }

        let activeBase: string | null = null;
        try {
          const baseResp = await downloadBaseOsu(difficultyId);
          activeBase = await decrypt(key, baseResp.encrypted_content, difficultyBaseOsuVersionAad(baseResp.id, mapsetId));
        } catch (err) {
          if (axios.isAxiosError(err) && err.response?.status === 404) {
            activeBase = null;
          } else {
            throw err;
          }
        }

        if (activeBase === null) {
          await performUpload(key, sectionText, candidateBase);
        } else {
          const report = diffBase(candidateBase, activeBase);
          if (report.critical.length > 0) {
            if (role === 'owner') {
              setModalMode('owner-critical');
            } else if (role === 'mapper' || role === 'modder') {
              setModalMode('mapper-critical');
            } else {
              setModalMode('legacy');
              setNormalizeCritical(false);
            }
            setDiffReport(report);
            setPendingUpload({ sectionContent: sectionText, candidateBase, activeBase });
            setModalOpen(true);
            setUploadState({ loading: false, error: null, success: false, warning: null });
          } else if (report.notice.length > 0 || report.timingPointsChanged) {
            const ok = await performUpload(key, sectionText, candidateBase);
            if (ok) {
              // notice entries come from the diff utility as .osu-section
              // identifiers (e.g. "AudioFilename"); keep TimingPoints as the
              // same kind of identifier so the message stays consistent rather
              // than mixing translated UI text with untranslated field names.
              const parts = [...report.notice];
              if (report.timingPointsChanged) parts.push('TimingPoints');
              setUploadState((s) => ({
                ...s,
                loading: false,
                warning: parts.length > 0 ? t('osuUpload.noticePrefix', { parts: parts.join(', ') }) : null,
              }));
            }
          } else {
            await performUpload(key, sectionText, null);
          }
        }
      } catch (err) {
        logger.warn('Upload failed:', err);
        const message = err instanceof Error ? err.message : t('osuUpload.errorUploadFailed');
        setUploadState({ loading: false, error: message, success: false, warning: null });
      }
    },
    [difficultyId, mapsetId, getKey, performUpload, role, t],
  );

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      event.target.value = '';

      if (!unlocked) {
        setUploadState({ loading: false, error: t('osuUpload.errorLocked'), success: false, warning: null });
        return;
      }

      if (
        assignedToUserId &&
        currentUserId &&
        assignedToUserId !== currentUserId &&
        !window.confirm(t('osuUpload.assignmentWarning', { username: assignedToUsername ?? t('osuUpload.assignmentWarningSomeone') }))
      ) {
        event.target.value = '';
        return;
      }

      // Reject by file.size before reading into memory — validateOsuFile would
      // catch it after the read, but only once the whole file is in memory.
      if (file.size > MAX_OSU_BYTES) {
        setUploadState({
          loading: false,
          error: t('osuUpload.errorFileTooLarge', { size: file.size, max: MAX_OSU_BYTES }),
          success: false,
          warning: null,
        });
        return;
      }

      setUploadState({ loading: true, error: null, success: false, warning: null });

      try {
        const text = await file.text();

        const validationError = validateOsuFile(text);
        if (validationError) {
          setUploadState({ loading: false, error: validationError, success: false, warning: null });
          return;
        }

        const parsed = parseOsuFile(text);

        // Sanitize to the section's range when start/end are known. Strips
        // hit objects, negative timing points, and break events that fall
        // outside [start, end) — otherwise a full-song .osu would duplicate
        // content under this section when the difficulty is merged.
        if (sectionRange) {
          const result = sanitizeSectionUpload(parsed, sectionRange.start, sectionRange.end);
          if (result.changed) {
            setSanitizeReport(result.dropped);
            setPendingSanitized({ original: text, sanitized: result.content });
            setModalMode('sanitize');
            setModalOpen(true);
            setUploadState({ loading: false, error: null, success: false, warning: null });
            return;
          }
          // Nothing trimmed; the sanitized content is identical to the input.
          // Pass the original twice — base derives from it, section uses it too.
          await proceedAfterSanitize(text, result.content);
          return;
        }

        // No section range provided (caller didn't pass it): upload as-is.
        await proceedAfterSanitize(text, text);
      } catch (err) {
        logger.warn('Upload failed:', err);
        const message = err instanceof Error ? err.message : t('osuUpload.errorUploadFailed');
        setUploadState({ loading: false, error: message, success: false, warning: null });
      }
    },
    [unlocked, sectionRange, proceedAfterSanitize, t],
  );

  const handleConfirmSanitize = useCallback(async () => {
    const pending = pendingSanitized;
    setModalOpen(false);
    setSanitizeReport(null);
    setPendingSanitized(null);
    if (!pending) return;
    await proceedAfterSanitize(pending.original, pending.sanitized);
  }, [pendingSanitized, proceedAfterSanitize]);

  const handleConfirmUpload = useCallback(async () => {
    if (!pendingUpload) return;
    setModalOpen(false);

    const key = await getKey(mapsetId);
    if (!key) {
      setUploadState({ loading: false, error: t('osuUpload.errorKeyMissing'), success: false, warning: null });
      return;
    }

    if (modalMode === 'owner-critical') {
      // Owner treats new file as authoritative: section as-is + new base.
      await performUpload(key, pendingUpload.sectionContent, pendingUpload.candidateBase);
    } else if (modalMode === 'mapper-critical') {
      // Mapper accepts base wins: normalize critical lines, section only.
      const normalized = pendingUpload.activeBase
        ? normalizeCriticalLines(pendingUpload.sectionContent, pendingUpload.activeBase)
        : pendingUpload.sectionContent;
      await performUpload(key, normalized, null);
    } else {
      // Legacy fallback: respect checkbox.
      let finalSection = pendingUpload.sectionContent;
      let finalBase = pendingUpload.candidateBase;
      if (normalizeCritical && pendingUpload.activeBase) {
        finalSection = normalizeCriticalLines(pendingUpload.sectionContent, pendingUpload.activeBase);
        finalBase = null;
      }
      await performUpload(key, finalSection, finalBase);
    }

    setPendingUpload(null);
    setDiffReport(null);
    setNormalizeCritical(false);
  }, [pendingUpload, mapsetId, getKey, performUpload, modalMode, normalizeCritical, t]);

  const handleCancelModal = useCallback(() => {
    setModalOpen(false);
    setPendingUpload(null);
    setDiffReport(null);
    setNormalizeCritical(false);
    setSanitizeReport(null);
    setPendingSanitized(null);
    setUploadState({ loading: false, error: null, success: false, warning: null });
  }, []);

  const renderModalContent = () => {
    if (modalMode === 'sanitize') {
      if (!sanitizeReport) return null;
      const items: string[] = [];
      if (sanitizeReport.hitObjects > 0) items.push(t('osuUpload.hitObjects', { count: sanitizeReport.hitObjects }));
      if (sanitizeReport.timingPoints > 0) items.push(t('osuUpload.timingPoints', { count: sanitizeReport.timingPoints }));
      if (sanitizeReport.breaks > 0) items.push(t('osuUpload.breaks', { count: sanitizeReport.breaks }));
      return (
        <>
          <h3 id="upload-confirm-title" className="text-lg font-semibold text-white mb-3">
            {t('osuUpload.sanitizeTitle')}
          </h3>
          <p className="text-sm text-gray-300 mb-4">
            {t('osuUpload.sanitizeBody')}
          </p>
          <div className="mb-3">
            <p className="text-xs font-semibold text-yellow-400 uppercase tracking-wide mb-1">{t('osuUpload.willDrop')}</p>
            <ul className="list-disc list-inside text-sm text-yellow-300">
              {items.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            {t('osuUpload.sanitizeFootnote')}
          </p>
          <div className="flex gap-3 justify-end mt-5">
            <button
              type="button"
              onClick={handleCancelModal}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={handleConfirmSanitize}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors"
            >
              {t('osuUpload.uploadTrimmed')}
            </button>
          </div>
        </>
      );
    }

    if (!pendingUpload || !diffReport) return null;

    if (modalMode === 'owner-critical') {
      return (
        <>
          <h3 id="upload-confirm-title" className="text-lg font-semibold text-white mb-3">
            {t('osuUpload.ownerTitle')}
          </h3>
          <p className="text-sm text-gray-300 mb-4">
            {t('osuUpload.ownerBody')}
          </p>
          <div className="mb-3">
            <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-1">{t('osuUpload.criticalChanges')}</p>
            <ul className="list-disc list-inside text-sm text-red-300">
              {diffReport.critical.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
          <div className="flex gap-3 justify-end mt-5">
            <button
              type="button"
              onClick={handleCancelModal}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={handleConfirmUpload}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded transition-colors"
            >
              {t('common.confirm')}
            </button>
          </div>
        </>
      );
    }

    if (modalMode === 'mapper-critical') {
      return (
        <>
          <h3 id="upload-confirm-title" className="text-lg font-semibold text-white mb-3">
            {t('osuUpload.mapperTitle')}
          </h3>
          <p className="text-sm text-gray-300 mb-4">
            {t('osuUpload.mapperBody')}
          </p>
          <div className="mb-3">
            <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-1">{t('osuUpload.differences')}</p>
            <ul className="list-disc list-inside text-sm text-red-300">
              {diffReport.critical.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
          <p className="text-sm text-gray-400 mb-4">
            {t('osuUpload.mapperFootnote')}
          </p>
          <div className="flex gap-3 justify-end mt-5">
            <button
              type="button"
              onClick={handleCancelModal}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={handleConfirmUpload}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors"
            >
              {t('osuUpload.imAware')}
            </button>
          </div>
        </>
      );
    }

    // Legacy fallback modal (used when no role is provided).
    return (
      <>
        <h3 id="upload-confirm-title" className="text-lg font-semibold text-white mb-3">
          {t('osuUpload.legacyTitle')}
        </h3>
        <p className="text-sm text-gray-300 mb-4">
          {t('osuUpload.legacyBody')}
        </p>

        {diffReport.critical.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-1">{t('osuUpload.criticalChanges')}</p>
            <ul className="list-disc list-inside text-sm text-red-300">
              {diffReport.critical.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <label className="flex items-center gap-2 mt-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={normalizeCritical}
                onChange={(e) => setNormalizeCritical(e.target.checked)}
                className="rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500"
              />
              {t('osuUpload.normalize')}
            </label>
          </div>
        )}

        {diffReport.notice.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-semibold text-yellow-400 uppercase tracking-wide mb-1">{t('osuUpload.noticeChanges')}</p>
            <ul className="list-disc list-inside text-sm text-yellow-300">
              {diffReport.notice.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex gap-3 justify-end mt-5">
          <button
            type="button"
            onClick={handleCancelModal}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirmUpload}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors"
          >
            {t('osuUpload.uploadAnyway')}
          </button>
        </div>
      </>
    );
  };

  return (
    <div className="flex flex-col gap-1">
      <input
        ref={fileInputRef}
        type="file"
        accept=".osu"
        className="hidden"
        onChange={handleFileSelect}
        aria-label={t('osuUpload.ariaLabel')}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploadState.loading}
        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 text-white text-xs font-medium rounded transition-colors"
      >
        {uploadState.loading ? t('osuUpload.uploading') : t('osuUpload.upload')}
      </button>

      {uploadState.error && (
        <p className="text-xs text-red-400" role="alert">
          {uploadState.error}
        </p>
      )}
      {uploadState.success && (
        <p className="text-xs text-green-400" role="status">
          {t('osuUpload.success')}
        </p>
      )}
      {uploadState.warning && (
        <p className="text-xs text-yellow-400" role="status">
          {uploadState.warning}
        </p>
      )}

      {modalOpen && (diffReport || sanitizeReport) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCancelModal();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="upload-confirm-title"
            className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl"
          >
            {renderModalContent()}
          </div>
        </div>
      )}
    </div>
  );
}
