import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  downloadBaseOsu,
  downloadSectionOsu,
  type Section,
} from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import {
  decrypt,
  decodeJsonEnvelope,
  sectionFieldAad,
  sectionOsuVersionAad,
  difficultyBaseOsuVersionAad,
} from '../utils/crypto';
import { mergeOsu } from '../utils/osuMerge';
import { sortSections } from '../utils/sectionOrder';
import { parseOsuFile, withMetadataVersion } from '../utils/osuParser';
import { composeOsuFilename } from '../utils/osuFilename';
import { logger } from '../utils/logger';

interface MergedDownloadButtonProps {
  difficultyId: string;
  mapsetId: string;
  mapsetTitle: string;
  sections: Section[];
  difficultyName?: string | null;
}

/** Which download is in flight, so the menu can show per-option progress. */
type LoadingAction = 'base' | 'full' | null;

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5v8M5 7.5l3 3 3-3M3 12.5h10" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/** Trigger a browser download of the given text as an .osu file. */
function saveOsu(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function MergedDownloadButton({
  difficultyId,
  mapsetId,
  mapsetTitle,
  sections,
  difficultyName,
}: MergedDownloadButtonProps) {
  const { t } = useTranslation();
  const { isUnlocked, getKey } = useEncryption();
  const [loadingAction, setLoadingAction] = useState<LoadingAction>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const unlocked = isUnlocked(mapsetId);
  const loading = loadingAction !== null;
  const hasSections = sections.length > 0;

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // Download just the active base template for this difficulty (no sections
  // merged in). This is difficulty-scoped, which is why it lives on the
  // difficulty's download menu rather than the mapset header.
  // The `loading` state isn't guarded against here: the trigger is disabled
  // while a download is in flight and the menu closes on click, so a second
  // invocation can't be issued mid-flight. Keeping `loading` out of the deps
  // also stops the callbacks churning identity on every load toggle.
  const handleDownloadBase = useCallback(async () => {
    if (!unlocked) return;
    setOpen(false);
    setLoadingAction('base');
    try {
      const key = await getKey(mapsetId);
      if (!key) return;
      const resp = await downloadBaseOsu(difficultyId);
      const plaintext = await decrypt(
        key,
        resp.encrypted_content,
        difficultyBaseOsuVersionAad(resp.id, mapsetId),
      );
      // Rewrite [Metadata] Version to "Base_version_<N>" so the editor and
      // filename match. resp.version may be undefined on older payloads.
      const diffName = `Base_version_${resp.version ?? 0}`;
      const { content: finalContent, metadata } = withMetadataVersion(
        parseOsuFile(plaintext),
        diffName,
      );
      const filename = composeOsuFilename({
        artist: metadata.artist,
        title: metadata.title,
        mapsetTitle,
        diffName,
      });
      saveOsu(finalContent, filename);
    } catch (err) {
      logger.warn('Failed to download base:', err);
    } finally {
      setLoadingAction(null);
    }
  }, [difficultyId, mapsetId, mapsetTitle, unlocked, getKey]);

  const handleDownloadFull = useCallback(async () => {
    if (!unlocked || !hasSections) return;
    setOpen(false);
    setLoadingAction('full');
    try {
      const key = await getKey(mapsetId);
      if (!key) return;

      // Fetch and decrypt base
      const baseResp = await downloadBaseOsu(difficultyId);
      const basePlaintext = await decrypt(
        key,
        baseResp.encrypted_content,
        difficultyBaseOsuVersionAad(baseResp.id, mapsetId),
      );

      // Fetch and decrypt all active section versions. Also pull endTimeMs +
      // sortOrder so mergeOsu can clip each section's hit objects to its
      // declared range (sections may still carry stray objects from a
      // pre-shortening version — see osuMerge §3).
      type SectionInputDraft = {
        content: string;
        sortOrder: number;
        sectionId: string;
        endTimeMs: number;
      };
      const drafts: SectionInputDraft[] = [];
      for (const section of sections) {
        try {
          const resp = await downloadSectionOsu(difficultyId, section.id);
          const aad = sectionFieldAad(section.id, mapsetId);
          const [plaintext, sortOrderRaw, endRaw] = await Promise.all([
            decrypt(key, resp.encrypted_content, sectionOsuVersionAad(resp.id, mapsetId)),
            decrypt(key, section.encrypted_sort_order, aad),
            decrypt(key, section.encrypted_end_time_ms, aad),
          ]);
          drafts.push({
            content: plaintext,
            sortOrder: decodeJsonEnvelope(sortOrderRaw),
            sectionId: section.id,
            endTimeMs: decodeJsonEnvelope(endRaw),
          });
        } catch (err) {
          logger.warn(`Failed to fetch section ${section.id} for merge:`, err);
        }
      }

      // Derive contiguous start times from sortOrder, matching the timeline
      // view in MapsetPage: each section starts where the previous one ended.
      // This relies on the invariant that sections are gapless — every
      // section's startTimeMs equals the previous section's endTimeMs. If
      // that invariant ever weakens (gaps or overlaps introduced server-side),
      // the running-total calculation below would silently misclip objects.
      const sortedDrafts = sortSections(drafts.map((d) => ({ ...d, id: d.sectionId })));
      let runningStart = 0;
      const sectionInputs = sortedDrafts.map((d, idx) => {
        const startTimeMs = runningStart;
        runningStart = d.endTimeMs;
        return {
          content: d.content,
          sortOrder: d.sortOrder,
          sectionId: d.id,
          startTimeMs,
          endTimeMs: d.endTimeMs,
          endInclusive: idx === drafts.length - 1,
        };
      });

      const merged = mergeOsu(basePlaintext, sectionInputs);

      // Rewrite [Metadata] Version to "<diffName>_version_<baseVersion>" so
      // the editor and the filename share the same label. The base version
      // is the closest "trunk version" for an assembled difficulty.
      const baseVersionLabel = baseResp.version ?? 0;
      const diffName = `${difficultyName ?? 'Difficulty'}_version_${baseVersionLabel}`;
      const { content: finalContent, metadata } = withMetadataVersion(
        parseOsuFile(merged),
        diffName,
      );
      const filename = composeOsuFilename({
        artist: metadata.artist,
        title: metadata.title,
        mapsetTitle,
        diffName,
      });

      saveOsu(finalContent, filename);
    } catch (err) {
      logger.warn('Merged download failed:', err);
    } finally {
      setLoadingAction(null);
    }
  }, [difficultyId, mapsetId, mapsetTitle, sections, hasSections, unlocked, getKey, difficultyName]);

  const menuId = `download-menu-${difficultyId}`;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!unlocked || loading}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t('mergedDownload.button')}
        title={!unlocked ? t('mergedDownload.titleLocked') : t('mergedDownload.button')}
        className="inline-flex items-center gap-2 px-4 py-3.5 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
      >
        <DownloadIcon />
        {loading ? t('mergedDownload.assembling') : t('mergedDownload.buttonShort')}
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t('mergedDownload.menuLabel')}
          className="absolute right-0 z-30 mt-1 min-w-full whitespace-nowrap rounded-lg border border-gray-700 bg-gray-800 shadow-xl py-1"
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleDownloadBase}
            className="block w-full px-4 py-2 text-left text-sm text-white hover:bg-gray-700 transition-colors"
          >
            {t('mergedDownload.optionBaseTemplate')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleDownloadFull}
            disabled={!hasSections}
            title={!hasSections ? t('mergedDownload.titleEmpty') : undefined}
            className="block w-full px-4 py-2 text-left text-sm text-white hover:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
          >
            {t('mergedDownload.optionFullDiff')}
          </button>
        </div>
      )}
    </div>
  );
}
