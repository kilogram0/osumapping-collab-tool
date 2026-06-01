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
import { diffBase, type DiffReport, normalizeFromBase } from '../utils/osuBase';
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
  /** Render the trigger as an icon-only button (no text) to match the
   *  standardized section action row. Status messages still render below. */
  iconOnly?: boolean;
}

function UploadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 10.5v-8M5 5.5l3-3 3 3M3 12.5h10" />
    </svg>
  );
}

interface UploadState {
  loading: boolean;
  error: string | null;
  success: boolean;
  warning: string | null;
}

type ModalMode = 'owner-critical' | 'mapper-critical' | 'owner-notice' | 'sanitize';

export default function OsuUploadButton({
  difficultyId,
  sectionId,
  mapsetId,
  role,
  sectionRange,
  assignedToUserId,
  currentUserId,
  assignedToUsername,
  iconOnly,
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
  const [modalMode, setModalMode] = useState<ModalMode>('sanitize');
  const [diffReport, setDiffReport] = useState<DiffReport | null>(null);
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

  const performUpload = useCallback(
    async (
      key: CryptoKey,
      sectionContent: string,
      candidateBase: string | null,
      successWarning: string | null = null,
    ): Promise<boolean> => {
      // successWarning lets the caller set the post-success banner
      // atomically with success=true. The previous pattern of doing
      // setUploadState((s) => ({ ...s, warning })) after the await
      // worked but coupled call sites to performUpload's internal
      // state shape — pass the warning here instead.
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

        setUploadState({ loading: false, error: null, success: true, warning: successWarning });
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

        // Only owners and mappers can upload .osu — matches the backend
        // allowlist in routers/sections.upload_section_osu and the spec
        // (modders are review-only, null role means we couldn't
        // determine membership). Fail fast before any server work.
        if (role !== 'owner' && role !== 'mapper') {
          setUploadState({ loading: false, error: t('osuUpload.errorCannotUpload'), success: false, warning: null });
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
          // No base yet — only the owner is allowed to seed it. Other
          // roles must wait until an owner uploads first; otherwise a
          // mapper could establish the base for everyone.
          if (role !== 'owner') {
            setUploadState({
              loading: false,
              error: t('osuUpload.errorFirstBaseOwnerOnly'),
              success: false,
              warning: null,
            });
            return;
          }
          await performUpload(key, sectionText, candidateBase);
          return;
        }

        const report = diffBase(candidateBase, activeBase);
        if (report.critical.length > 0) {
          // Critical diff: opens role-specific modal. (`role` is
          // narrowed to 'owner' | 'mapper' by the gate above.)
          setModalMode(role === 'owner' ? 'owner-critical' : 'mapper-critical');
          setDiffReport(report);
          setPendingUpload({ sectionContent: sectionText, candidateBase, activeBase });
          setModalOpen(true);
          setUploadState({ loading: false, error: null, success: false, warning: null });
        } else if (report.notice.length > 0) {
          if (role === 'owner') {
            // Owner notice-only diff: confirm intent (promote vs normalize).
            setModalMode('owner-notice');
            setDiffReport(report);
            setPendingUpload({ sectionContent: sectionText, candidateBase, activeBase });
            setModalOpen(true);
            setUploadState({ loading: false, error: null, success: false, warning: null });
          } else {
            // Mapper notice-only diff: silently normalize the section
            // to match the base, skip creating a new base version, and
            // warn the user about what was overwritten.
            const normalized = normalizeFromBase(sectionText, activeBase, { critical: false, notice: true });
            await performUpload(
              key,
              normalized,
              null,
              t('osuUpload.noticeNormalizedWarning', { parts: report.notice.join(', ') }),
            );
          }
        } else {
          await performUpload(key, sectionText, null);
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

  // Promote = treat the uploaded file as authoritative: section as-is +
  // new base. Same behavior whether the diff was critical or notice;
  // wired to "Confirm" on owner-critical and "Promote to base" on
  // owner-notice.
  const handleConfirmPromote = useCallback(async () => {
    if (!pendingUpload) return;
    setModalOpen(false);
    const key = await getKey(mapsetId);
    if (!key) {
      setUploadState({ loading: false, error: t('osuUpload.errorKeyMissing'), success: false, warning: null });
      return;
    }
    await performUpload(key, pendingUpload.sectionContent, pendingUpload.candidateBase);
    setPendingUpload(null);
    setDiffReport(null);
  }, [pendingUpload, mapsetId, getKey, performUpload, t]);

  // Discard / "I'm aware" = rewrite the section to match the active
  // base on BOTH scopes (critical and notice), upload section only, no
  // new base. We normalize notice too even though only critical is in
  // the modal — otherwise a combined critical+notice diff would silently
  // keep the notice changes in the section content, which is the same
  // footgun this whole change is trying to close.
  // Wired to "I'm aware" on mapper-critical and "Discard my changes" on
  // owner-critical. The owner-critical path shows a banner listing what
  // was overwritten so the owner sees their discarded edits.
  const handleConfirmNormalizeCritical = useCallback(async () => {
    if (!pendingUpload) return;
    setModalOpen(false);
    const key = await getKey(mapsetId);
    if (!key) {
      setUploadState({ loading: false, error: t('osuUpload.errorKeyMissing'), success: false, warning: null });
      return;
    }
    const normalized = pendingUpload.activeBase
      ? normalizeFromBase(pendingUpload.sectionContent, pendingUpload.activeBase, {
          critical: true,
          notice: true,
        })
      : pendingUpload.sectionContent;
    const banner =
      diffReport && modalMode === 'owner-critical'
        ? t('osuUpload.criticalNormalizedWarning', {
            parts: [...diffReport.critical, ...diffReport.notice].join(', '),
          })
        : null;
    await performUpload(key, normalized, null, banner);
    setPendingUpload(null);
    setDiffReport(null);
  }, [pendingUpload, diffReport, modalMode, mapsetId, getKey, performUpload, t]);

  // Normalize notice = rewrite the section's notice fields to match the
  // active base, upload section only, no new base. Wired to "Discard my
  // changes" on owner-notice.
  const handleConfirmNormalizeNotice = useCallback(async () => {
    if (!pendingUpload || !pendingUpload.activeBase) return;
    setModalOpen(false);
    const key = await getKey(mapsetId);
    if (!key) {
      setUploadState({ loading: false, error: t('osuUpload.errorKeyMissing'), success: false, warning: null });
      return;
    }
    const normalized = normalizeFromBase(pendingUpload.sectionContent, pendingUpload.activeBase, {
      critical: false,
      notice: true,
    });
    const banner = diffReport
      ? t('osuUpload.noticeNormalizedWarning', { parts: diffReport.notice.join(', ') })
      : null;
    await performUpload(key, normalized, null, banner);
    setPendingUpload(null);
    setDiffReport(null);
  }, [pendingUpload, diffReport, mapsetId, getKey, performUpload, t]);

  const handleCancelModal = useCallback(() => {
    setModalOpen(false);
    setPendingUpload(null);
    setDiffReport(null);
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

    // Render one diff entry. If the field has a (candidate, active) pair
    // in `values` we show a "base → yours" comparison. Line-list fields
    // (Events, TimingPoints) don't have a useful pair to show — they get
    // a localized hint instead.
    const renderEntry = (field: string, tone: 'critical' | 'notice') => {
      const pair = diffReport.values[field];
      const toneClass = tone === 'critical' ? 'text-red-300' : 'text-yellow-300';
      const labelClass = tone === 'critical' ? 'text-red-400' : 'text-yellow-400';
      const renderValue = (v: string | null) =>
        v === null ? <em className="text-gray-500">{t('osuUpload.diffMissingValue')}</em> : <code className="text-gray-200">{v}</code>;
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
            <ul className="list-disc list-inside text-sm">
              {diffReport.critical.map((c) => renderEntry(c, 'critical'))}
            </ul>
          </div>
          {diffReport.notice.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-semibold text-yellow-400 uppercase tracking-wide mb-1">{t('osuUpload.alsoChanged')}</p>
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
            <ul className="list-disc list-inside text-sm">
              {diffReport.critical.map((c) => renderEntry(c, 'critical'))}
            </ul>
          </div>
          {diffReport.notice.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-semibold text-yellow-400 uppercase tracking-wide mb-1">{t('osuUpload.alsoChanged')}</p>
              <ul className="list-disc list-inside text-sm">
                {diffReport.notice.map((n) => renderEntry(n, 'notice'))}
              </ul>
            </div>
          )}
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
              onClick={handleConfirmNormalizeCritical}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors"
            >
              {t('osuUpload.imAware')}
            </button>
          </div>
        </>
      );
    }

    // owner-notice
    return (
      <>
        <h3 id="upload-confirm-title" className="text-lg font-semibold text-white mb-3">
          {t('osuUpload.ownerNoticeTitle')}
        </h3>
        <p className="text-sm text-gray-300 mb-4">
          {t('osuUpload.ownerNoticeBody')}
        </p>
        <div className="mb-3">
          <p className="text-xs font-semibold text-yellow-400 uppercase tracking-wide mb-1">{t('osuUpload.noticeChanges')}</p>
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
        aria-label={t('osuUpload.ariaLabel')}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploadState.loading}
        aria-label={iconOnly ? t('osuUpload.upload') : undefined}
        title={iconOnly ? t('osuUpload.upload') : undefined}
        className={
          iconOnly
            ? 'inline-flex items-center justify-center p-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 text-white rounded transition-colors'
            : 'px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 text-white text-xs font-medium rounded transition-colors'
        }
      >
        {iconOnly ? <UploadIcon /> : uploadState.loading ? t('osuUpload.uploading') : t('osuUpload.upload')}
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
