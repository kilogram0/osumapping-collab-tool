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
  parseBookmarks,
  withBookmarks,
  buildCandidateBase,
  validateOsuFile,
  sliceForSection,
  MAX_OSU_BYTES,
} from '../utils/osuParser';
import { diffBase, type DiffReport, normalizeFromBase } from '../utils/osuBase';
import { bookmarksFromSections } from '../utils/syncBaseBookmarks';
import { logger } from '../utils/logger';
import type { DecryptedSection } from './SectionList';

interface Props {
  difficultyId: string;
  mapsetId: string;
  sections: DecryptedSection[];
  /** Render as a compact icon button instead of a labelled button. */
  iconOnly?: boolean;
}

function UploadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 10.5v-8M5 5.5l3-3 3 3M3 12.5h10" />
    </svg>
  );
}

type ModalMode = 'owner-critical' | 'owner-notice';

interface SectionSlice {
  sectionId: string;
  content: string;
}

interface PendingData {
  slices: SectionSlice[];
  candidateBase: string;
  // activeBase is always non-null when pendingData is set — the modal only
  // opens after a successful base download + diffBase call.
  activeBase: string;
}

export default function FullDifficultyUploadButton({ difficultyId, mapsetId, sections, iconOnly = false }: Props) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { isUnlocked, getKey } = useEncryption();
  const unlocked = isUnlocked(mapsetId);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>('owner-critical');
  const [diffReport, setDiffReport] = useState<DiffReport | null>(null);
  const [pendingData, setPendingData] = useState<PendingData | null>(null);

  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
    };
  }, []);

  const handleCancelModal = useCallback(() => {
    setModalOpen(false);
    setPendingData(null);
    setDiffReport(null);
    setLoading(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (!modalOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') handleCancelModal();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [modalOpen, handleCancelModal]);

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['sections', difficultyId] });
    queryClient.invalidateQueries({ queryKey: ['difficulties', difficultyId] });
    queryClient.invalidateQueries({ queryKey: ['base-osu-versions', difficultyId] });
    for (const s of sections) {
      queryClient.invalidateQueries({ queryKey: ['section-osu-versions', difficultyId, s.id] });
    }
  }, [queryClient, difficultyId, sections]);

  // Upload each slice sequentially. candidateBase is included only on the
  // first upload so a single new base version is created for the difficulty.
  const performBatchUpload = useCallback(
    async (key: CryptoKey, slices: SectionSlice[], candidateBase: string | null) => {
      setLoading(true);
      setError(null);

      try {
        for (let i = 0; i < slices.length; i++) {
          const { sectionId, content } = slices[i];
          const sectionVersionId = crypto.randomUUID();
          const encryptedSection = await encrypt(
            key,
            content,
            sectionOsuVersionAad(sectionVersionId, mapsetId),
          );

          const payload: UploadSectionOsuPayload = {
            id: sectionVersionId,
            encrypted_content: encryptedSection,
          };

          if (i === 0 && candidateBase !== null) {
            const baseVersionId = crypto.randomUUID();
            const encryptedBase = await encrypt(
              key,
              candidateBase,
              difficultyBaseOsuVersionAad(baseVersionId, mapsetId),
            );
            payload.base_version = { id: baseVersionId, encrypted_content: encryptedBase };
          }

          await uploadSectionOsu(difficultyId, sectionId, payload);
        }

        setSuccess(true);
        if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
        successTimeoutRef.current = setTimeout(() => setSuccess(false), 3000);
      } catch (err) {
        logger.warn('Full difficulty upload failed:', err);
        setError(err instanceof Error ? err.message : t('fullUpload.errorUploadFailed'));
      } finally {
        // Invalidate on both success and partial failure — a section that
        // uploaded before the throw left its cache entry stale.
        invalidateAll();
        setLoading(false);
      }
    },
    [difficultyId, mapsetId, invalidateAll, t],
  );

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      event.target.value = '';

      if (!unlocked) {
        setError(t('osuUpload.errorLocked'));
        return;
      }

      if (sections.length === 0) {
        setError(t('fullUpload.errorNoSections'));
        return;
      }

      if (file.size > MAX_OSU_BYTES) {
        setError(t('osuUpload.errorFileTooLarge', { size: file.size, max: MAX_OSU_BYTES }));
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const text = await file.text();

        const validationError = validateOsuFile(text);
        if (validationError) {
          setError(validationError);
          setLoading(false);
          return;
        }

        const parsed = parseOsuFile(text);
        const candidateBaseRaw = buildCandidateBase(parsed);

        // Slice the full file into per-section content sorted by time order.
        // Unlike single-section upload there is no "sanitize" confirmation —
        // the user is explicitly uploading a full difficulty to be split.
        const sorted = [...sections].sort((a, b) => a.sortOrder - b.sortOrder);
        const slices: SectionSlice[] = sorted.map((s) => ({
          sectionId: s.id,
          content: sliceForSection(parsed, s.startTimeMs, s.endTimeMs),
        }));

        const key = await getKey(mapsetId);
        if (!key) {
          setError(t('osuUpload.errorKeyMissing'));
          setLoading(false);
          return;
        }

        let activeBase: string | null = null;
        try {
          const baseResp = await downloadBaseOsu(difficultyId);
          activeBase = await decrypt(
            key,
            baseResp.encrypted_content,
            difficultyBaseOsuVersionAad(baseResp.id, mapsetId),
          );
        } catch (err) {
          if (axios.isAxiosError(err) && err.response?.status === 404) {
            activeBase = null;
          } else {
            throw err;
          }
        }

        // A full-diff upload must NOT replace the base's bookmarks with the
        // uploaded file's — only the explicit Import Bookmarks / re-section
        // flows set bookmarks. Keep the existing base's bookmarks when one
        // exists; otherwise seed from the current section divisions. (diffBase
        // ignores [Editor], so this doesn't affect the promote decision.)
        const preservedBookmarks = activeBase !== null
          ? parseBookmarks(parseOsuFile(activeBase))
          : bookmarksFromSections(sections);
        const candidateBase = withBookmarks(parseOsuFile(candidateBaseRaw), preservedBookmarks);

        if (activeBase === null) {
          // No base yet — seed it along with all sections.
          await performBatchUpload(key, slices, candidateBase);
          return;
        }

        const report = diffBase(candidateBase, activeBase);

        if (report.critical.length > 0) {
          setModalMode('owner-critical');
          setDiffReport(report);
          setPendingData({ slices, candidateBase, activeBase });
          setModalOpen(true);
          setLoading(false);
        } else if (report.notice.length > 0) {
          setModalMode('owner-notice');
          setDiffReport(report);
          setPendingData({ slices, candidateBase, activeBase });
          setModalOpen(true);
          setLoading(false);
        } else {
          // Clean — upload sections without promoting the base.
          await performBatchUpload(key, slices, null);
        }
      } catch (err) {
        logger.warn('Full difficulty upload failed:', err);
        setError(err instanceof Error ? err.message : t('fullUpload.errorUploadFailed'));
        setLoading(false);
      }
    },
    [unlocked, sections, mapsetId, difficultyId, getKey, performBatchUpload, t],
  );

  const handleConfirmPromote = useCallback(async () => {
    if (!pendingData) return;
    setModalOpen(false);
    const key = await getKey(mapsetId);
    if (!key) {
      setError(t('osuUpload.errorKeyMissing'));
      return;
    }
    await performBatchUpload(key, pendingData.slices, pendingData.candidateBase);
    setPendingData(null);
    setDiffReport(null);
  }, [pendingData, mapsetId, getKey, performBatchUpload, t]);

  const handleConfirmNormalizeCritical = useCallback(async () => {
    if (!pendingData) return;
    setModalOpen(false);
    const key = await getKey(mapsetId);
    if (!key) {
      setError(t('osuUpload.errorKeyMissing'));
      return;
    }
    const normalized: SectionSlice[] = pendingData.slices.map((s) => ({
      sectionId: s.sectionId,
      content: normalizeFromBase(s.content, pendingData.activeBase, { critical: true, notice: true }),
    }));
    await performBatchUpload(key, normalized, null);
    setPendingData(null);
    setDiffReport(null);
  }, [pendingData, mapsetId, getKey, performBatchUpload, t]);

  const handleConfirmNormalizeNotice = useCallback(async () => {
    if (!pendingData) return;
    setModalOpen(false);
    const key = await getKey(mapsetId);
    if (!key) {
      setError(t('osuUpload.errorKeyMissing'));
      return;
    }
    const normalized: SectionSlice[] = pendingData.slices.map((s) => ({
      sectionId: s.sectionId,
      content: normalizeFromBase(s.content, pendingData.activeBase, { critical: false, notice: true }),
    }));
    await performBatchUpload(key, normalized, null);
    setPendingData(null);
    setDiffReport(null);
  }, [pendingData, mapsetId, getKey, performBatchUpload, t]);

  const renderEntry = (field: string, tone: 'critical' | 'notice') => {
    if (!diffReport) return null;
    const pair = diffReport.values[field];
    const toneClass = tone === 'critical' ? 'text-red-300' : 'text-yellow-300';
    const labelClass = tone === 'critical' ? 'text-red-400' : 'text-yellow-400';
    const renderValue = (v: string | null) =>
      v === null
        ? <em className="text-gray-500">{t('osuUpload.diffMissingValue')}</em>
        : <code className="text-gray-200">{v}</code>;
    return (
      <li key={field} className={toneClass}>
        <span className={`font-medium ${labelClass}`}>{field}</span>
        {pair ? (
          <span className="ml-2 text-xs text-gray-400">
            {t('osuUpload.diffBaseLabel')} {renderValue(pair.active)}
            {' → '}
            {t('osuUpload.diffYoursLabel')} {renderValue(pair.candidate)}
          </span>
        ) : (
          <span className="ml-2 text-xs text-gray-400">{t('osuUpload.diffLineListHint')}</span>
        )}
      </li>
    );
  };

  const renderModalContent = () => {
    if (!diffReport) return null;

    if (modalMode === 'owner-critical') {
      return (
        <>
          <h3 id="full-upload-modal-title" className="text-lg font-semibold text-white mb-3">
            {t('osuUpload.ownerTitle')}
          </h3>
          <p className="text-sm text-gray-300 mb-4">
            {t('osuUpload.ownerBody')}
          </p>
          <div className="mb-3">
            <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-1">
              {t('osuUpload.criticalChanges')}
            </p>
            <ul className="list-disc list-inside text-sm">
              {diffReport.critical.map((c) => renderEntry(c, 'critical'))}
            </ul>
          </div>
          {diffReport.notice.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-semibold text-yellow-400 uppercase tracking-wide mb-1">
                {t('osuUpload.alsoChanged')}
              </p>
              <ul className="list-disc list-inside text-sm">
                {diffReport.notice.map((n) => renderEntry(n, 'notice'))}
              </ul>
            </div>
          )}
          <div className="flex gap-3 justify-end mt-5 flex-wrap">
            <button
              type="button"
              onClick={handleCancelModal}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={handleConfirmNormalizeCritical}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white text-sm font-medium rounded transition-colors"
            >
              {t('osuUpload.ownerCriticalNormalize')}
            </button>
            <button
              type="button"
              onClick={handleConfirmPromote}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded transition-colors"
            >
              {t('osuUpload.ownerCriticalPromote')}
            </button>
          </div>
        </>
      );
    }

    return (
      <>
        <h3 id="full-upload-modal-title" className="text-lg font-semibold text-white mb-3">
          {t('osuUpload.ownerNoticeTitle')}
        </h3>
        <p className="text-sm text-gray-300 mb-4">
          {t('osuUpload.ownerNoticeBody')}
        </p>
        <div className="mb-3">
          <p className="text-xs font-semibold text-yellow-400 uppercase tracking-wide mb-1">
            {t('osuUpload.noticeChanges')}
          </p>
          <ul className="list-disc list-inside text-sm">
            {diffReport.notice.map((n) => renderEntry(n, 'notice'))}
          </ul>
        </div>
        <div className="flex gap-3 justify-end mt-5 flex-wrap">
          <button
            type="button"
            onClick={handleCancelModal}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirmNormalizeNotice}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white text-sm font-medium rounded transition-colors"
          >
            {t('osuUpload.ownerNoticeNormalize')}
          </button>
          <button
            type="button"
            onClick={handleConfirmPromote}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors"
          >
            {t('osuUpload.ownerNoticePromote')}
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
        aria-label={t('fullUpload.ariaLabel')}
      />
      {iconOnly ? (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading || sections.length === 0}
          aria-label={t('fullUpload.button')}
          title={sections.length === 0 ? t('fullUpload.noSectionsTooltip') : t('fullUpload.button')}
          className="px-4 py-3.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
          <UploadIcon />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading || sections.length === 0}
          title={sections.length === 0 ? t('fullUpload.noSectionsTooltip') : undefined}
          className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:bg-purple-900 disabled:cursor-not-allowed text-white text-sm font-medium rounded transition-colors"
        >
          {loading ? t('fullUpload.uploading') : t('fullUpload.button')}
        </button>
      )}
      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="text-xs text-green-400" role="status">
          {t('fullUpload.success')}
        </p>
      )}
      {modalOpen && diffReport && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCancelModal();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="full-upload-modal-title"
            className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl"
          >
            {renderModalContent()}
          </div>
        </div>
      )}
    </div>
  );
}
