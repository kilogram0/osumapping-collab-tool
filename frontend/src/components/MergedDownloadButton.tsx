import { useState, useCallback } from 'react';
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

export default function MergedDownloadButton({
  difficultyId,
  mapsetId,
  mapsetTitle,
  sections,
  difficultyName,
}: MergedDownloadButtonProps) {
  const { t } = useTranslation();
  const { isUnlocked, getKey } = useEncryption();
  const [loading, setLoading] = useState(false);
  const unlocked = isUnlocked(mapsetId);

  const handleDownload = useCallback(async () => {
    if (!unlocked) return;
    setLoading(true);
    try {
      const key = await getKey(mapsetId);
      if (!key) {
        setLoading(false);
        return;
      }

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

      const blob = new Blob([finalContent], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      logger.warn('Merged download failed:', err);
    } finally {
      setLoading(false);
    }
  }, [difficultyId, mapsetId, mapsetTitle, sections, unlocked, getKey, difficultyName]);

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={!unlocked || loading || sections.length === 0}
      className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 text-white text-sm font-medium rounded transition-colors"
      title={!unlocked ? t('mergedDownload.titleLocked') : sections.length === 0 ? t('mergedDownload.titleEmpty') : t('mergedDownload.titleDownload')}
    >
      {loading ? t('mergedDownload.assembling') : t('mergedDownload.button')}
    </button>
  );
}
