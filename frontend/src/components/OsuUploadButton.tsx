import { useRef, useState, useCallback, useEffect } from 'react';
import axios from 'axios';
import { useQueryClient } from '@tanstack/react-query';
import {
  uploadSectionOsu,
  downloadBaseOsu,
  type UploadSectionOsuPayload,
} from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { encrypt, decrypt, sectionOsuVersionAad, difficultyBaseOsuVersionAad } from '../utils/crypto';
import { parseOsuFile, buildCandidateBase, validateOsuFile } from '../utils/osuParser';
import { diffBase, type DiffReport, normalizeCriticalLines } from '../utils/osuBase';
import { logger } from '../utils/logger';

interface OsuUploadButtonProps {
  difficultyId: string;
  sectionId: string;
  mapsetId: string;
  role?: 'owner' | 'mapper' | 'modder' | null;
}

interface UploadState {
  loading: boolean;
  error: string | null;
  success: boolean;
  warning: string | null;
}

type ModalMode = 'owner-critical' | 'mapper-critical' | 'legacy';

export default function OsuUploadButton({ difficultyId, sectionId, mapsetId, role }: OsuUploadButtonProps) {
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
        const message = err instanceof Error ? err.message : 'Upload failed';
        setUploadState({ loading: false, error: message, success: false, warning: null });
        return false;
      }
    },
    [difficultyId, sectionId, mapsetId, queryClient],
  );

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      event.target.value = '';

      if (!unlocked) {
        setUploadState({ loading: false, error: 'Mapset is locked. Enter the passphrase first.', success: false, warning: null });
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
        const candidateBase = buildCandidateBase(parsed);

        const key = await getKey(mapsetId);
        if (!key) {
          setUploadState({ loading: false, error: 'Encryption key not found.', success: false, warning: null });
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
          await performUpload(key, text, candidateBase);
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
            setPendingUpload({ sectionContent: text, candidateBase, activeBase });
            setModalOpen(true);
            setUploadState({ loading: false, error: null, success: false, warning: null });
          } else if (report.notice.length > 0 || report.timingPointsChanged) {
            // Notice-only diff: auto-upload both section and base.
            const ok = await performUpload(key, text, candidateBase);
            if (ok) {
              const parts = [...report.notice];
              if (report.timingPointsChanged) parts.push('TimingPoints');
              setUploadState((s) => ({
                ...s,
                loading: false,
                warning: parts.length > 0 ? `Notice: ${parts.join(', ')}` : null,
              }));
            }
          } else {
            // No diff: upload section only.
            await performUpload(key, text, null);
          }
        }
      } catch (err) {
        logger.warn('Upload failed:', err);
        const message = err instanceof Error ? err.message : 'Upload failed';
        setUploadState({ loading: false, error: message, success: false, warning: null });
      }
    },
    [difficultyId, mapsetId, unlocked, getKey, performUpload, role],
  );

  const handleConfirmUpload = useCallback(async () => {
    if (!pendingUpload) return;
    setModalOpen(false);

    const key = await getKey(mapsetId);
    if (!key) {
      setUploadState({ loading: false, error: 'Encryption key not found.', success: false, warning: null });
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
  }, [pendingUpload, mapsetId, getKey, performUpload, modalMode, normalizeCritical]);

  const handleCancelModal = useCallback(() => {
    setModalOpen(false);
    setPendingUpload(null);
    setDiffReport(null);
    setNormalizeCritical(false);
    setUploadState({ loading: false, error: null, success: false, warning: null });
  }, []);

  const renderModalContent = () => {
    if (!pendingUpload || !diffReport) return null;

    if (modalMode === 'owner-critical') {
      return (
        <>
          <h3 id="upload-confirm-title" className="text-lg font-semibold text-white mb-3">
            CRITICAL: Are you sure?
          </h3>
          <p className="text-sm text-gray-300 mb-4">
            You are about to change critical settings on the base. Every collaborator&apos;s section will use these settings going forward.
          </p>
          <div className="mb-3">
            <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-1">Critical Changes</p>
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
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmUpload}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded transition-colors"
            >
              Confirm
            </button>
          </div>
        </>
      );
    }

    if (modalMode === 'mapper-critical') {
      return (
        <>
          <h3 id="upload-confirm-title" className="text-lg font-semibold text-white mb-3">
            Differs from Base
          </h3>
          <p className="text-sm text-gray-300 mb-4">
            Your diff&apos;s critical settings differ from the active base. Make sure you&apos;re uploading the correct difficulty.
          </p>
          <div className="mb-3">
            <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-1">Differences</p>
            <ul className="list-disc list-inside text-sm text-red-300">
              {diffReport.critical.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
          <p className="text-sm text-gray-400 mb-4">
            Clicking &quot;I&apos;m aware&quot; will normalize your file&apos;s critical lines to match the base before uploading.
          </p>
          <div className="flex gap-3 justify-end mt-5">
            <button
              type="button"
              onClick={handleCancelModal}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmUpload}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors"
            >
              I&apos;m aware
            </button>
          </div>
        </>
      );
    }

    // Legacy fallback modal (used when no role is provided).
    return (
      <>
        <h3 id="upload-confirm-title" className="text-lg font-semibold text-white mb-3">
          Upload Confirmation
        </h3>
        <p className="text-sm text-gray-300 mb-4">
          The uploaded file differs from the active base. Review the changes below:
        </p>

        {diffReport.critical.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-1">Critical Changes</p>
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
              Normalize critical lines to match active base
            </label>
          </div>
        )}

        {diffReport.notice.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-semibold text-yellow-400 uppercase tracking-wide mb-1">Notice Changes</p>
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
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirmUpload}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors"
          >
            Upload Anyway
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
        aria-label="Upload .osu file"
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploadState.loading}
        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 text-white text-xs font-medium rounded transition-colors"
      >
        {uploadState.loading ? 'Uploading…' : 'Upload .osu'}
      </button>

      {uploadState.error && (
        <p className="text-xs text-red-400" role="alert">
          {uploadState.error}
        </p>
      )}
      {uploadState.success && (
        <p className="text-xs text-green-400" role="status">
          Upload successful!
        </p>
      )}
      {uploadState.warning && (
        <p className="text-xs text-yellow-400" role="status">
          {uploadState.warning}
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
