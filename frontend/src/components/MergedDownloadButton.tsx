import { useState, useCallback } from 'react';
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

      // Fetch and decrypt all active section versions
      const sectionInputs: { content: string; sortOrder: number; sectionId: string }[] = [];
      for (const section of sections) {
        try {
          const resp = await downloadSectionOsu(difficultyId, section.id);
          const plaintext = await decrypt(
            key,
            resp.encrypted_content,
            sectionOsuVersionAad(resp.id, mapsetId),
          );
          const sortOrderRaw = await decrypt(
            key,
            section.encrypted_sort_order,
            sectionFieldAad(section.id, mapsetId),
          );
          const sortOrder = decodeJsonEnvelope(sortOrderRaw);
          sectionInputs.push({ content: plaintext, sortOrder, sectionId: section.id });
        } catch (err) {
          logger.warn(`Failed to fetch section ${section.id} for merge:`, err);
        }
      }

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
      title={!unlocked ? 'Unlock mapset to download' : sections.length === 0 ? 'No sections to merge' : 'Download merged .osu'}
    >
      {loading ? 'Assembling…' : 'Download Full Difficulty (.osu)'}
    </button>
  );
}
