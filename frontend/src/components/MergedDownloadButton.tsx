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
import { logger } from '../utils/logger';

interface MergedDownloadButtonProps {
  difficultyId: string;
  mapsetId: string;
  sections: Section[];
}

export default function MergedDownloadButton({
  difficultyId,
  mapsetId,
  sections,
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

      const blob = new Blob([merged], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'merged.osu';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      logger.warn('Merged download failed:', err);
    } finally {
      setLoading(false);
    }
  }, [difficultyId, mapsetId, sections, unlocked, getKey]);

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
