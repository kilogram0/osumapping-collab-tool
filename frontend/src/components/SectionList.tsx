import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { Section } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { decrypt, decodeJsonEnvelope, sectionFieldAad } from '../utils/crypto';
import { assembleSectionOsu } from '../utils/sectionDownload';
import { parseOsuFile, withMetadataVersion } from '../utils/osuParser';
import { composeOsuFilename } from '../utils/osuFilename';
import { logger } from '../utils/logger';
import OsuUploadButton from './OsuUploadButton';
import OsuVersionHistory from './OsuVersionHistory';

interface SectionListProps {
  sections: Section[];
  mapsetId: string;
  mapsetTitle: string;
  difficultyId: string;
  onEdit?: (section: DecryptedSection) => void;
  onDecrypted?: (sections: DecryptedSection[]) => void;
  role?: 'owner' | 'mapper' | 'modder' | null;
}

export interface DecryptedSection {
  id: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  sortOrder: number;
  assignedTo: string | null;
}

export default function SectionList({ sections, mapsetId, mapsetTitle, difficultyId, onEdit, onDecrypted, role }: SectionListProps) {
  const { t } = useTranslation();
  const { isUnlocked, getKey } = useEncryption();
  const [decrypted, setDecrypted] = useState<DecryptedSection[]>([]);
  const [historySectionId, setHistorySectionId] = useState<string | null>(null);
  const unlocked = isUnlocked(mapsetId);

  useEffect(() => {
    if (!unlocked) {
      setDecrypted([]);
      return;
    }
    let cancelled = false;

    async function decryptAll() {
      const key = await getKey(mapsetId);
      if (!key || cancelled) return;
      const results: DecryptedSection[] = [];
      await Promise.all(
        sections.map(async (s) => {
          try {
            const [name, startRaw, endRaw, sortRaw] = await Promise.all([
              decrypt(key, s.encrypted_name, sectionFieldAad(s.id, mapsetId)),
              decrypt(key, s.encrypted_start_time_ms, sectionFieldAad(s.id, mapsetId)),
              decrypt(key, s.encrypted_end_time_ms, sectionFieldAad(s.id, mapsetId)),
              decrypt(key, s.encrypted_sort_order, sectionFieldAad(s.id, mapsetId)),
            ]);
            results.push({
              id: s.id,
              name,
              startTimeMs: decodeJsonEnvelope(startRaw),
              endTimeMs: decodeJsonEnvelope(endRaw),
              sortOrder: decodeJsonEnvelope(sortRaw),
            });
          } catch (_err) {
            logger.warn(`Failed to decrypt section ${s.id}:`, _err);
          }
        }),
      );
      if (!cancelled) {
        results.sort((a, b) => a.startTimeMs - b.startTimeMs || a.id.localeCompare(b.id));
        setDecrypted(results);
        onDecrypted?.(results);
      }
    }

    decryptAll();
    return () => { cancelled = true; };
  }, [unlocked, sections, mapsetId, getKey, onDecrypted]);

  const handleDownload = useCallback(
    async (sectionId: string, sectionName: string, sortOrder: number) => {
      if (!unlocked) return;
      try {
        const key = await getKey(mapsetId);
        if (!key) return;
        // Merge with the active base so the downloaded file carries the
        // positive BPM timing points (which live on DifficultyBaseOsuVersion).
        const assembled = await assembleSectionOsu({
          difficultyId,
          sectionId,
          mapsetId,
          key,
          sortOrder,
        });
        const diffName = `${sectionName}_version_${assembled.sectionVersion}`;
        const { content: finalContent, metadata } = withMetadataVersion(
          parseOsuFile(assembled.content),
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
        logger.warn(`Failed to download section ${sectionId}:`, err);
      }
    },
    [difficultyId, mapsetId, mapsetTitle, unlocked, getKey],
  );

  if (sections.length === 0) {
    return (
      <p className="text-sm text-gray-500 italic">{t('sectionList.empty')}</p>
    );
  }

  function formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const millis = ms % 1000;
    const mm = minutes.toString().padStart(2, '0');
    const ss = seconds.toString().padStart(2, '0');
    const mmm = millis.toString().padStart(3, '0');
    if (hours > 0) {
      return `${hours}:${mm}:${ss}.${mmm}`;
    }
    return `${mm}:${ss}.${mmm}`;
  }

  if (unlocked && decrypted.length === 0 && sections.length > 0) {
    return (
      <ul className="space-y-2" aria-label={t('sectionList.ariaLabel')}>
        {sections.map((s) => (
          <li
            key={s.id}
            className="bg-gray-800 border border-gray-700 rounded-lg p-3"
          >
            <p className="text-red-400 font-medium text-sm">{t('sectionList.failedDecrypt')}</p>
          </li>
        ))}
      </ul>
    );
  }

  // Two branches so the unlocked .map narrows to DecryptedSection — otherwise
  // a single discriminated-union iteration loses startTimeMs/endTimeMs/sortOrder
  // typing inside the map callback and TS reports "number | null" / "missing
  // sortOrder" at the OsuUploadButton + handleDownload call sites.
  if (!unlocked) {
    return (
      <ul className="space-y-2" aria-label={t('sectionList.ariaLabel')}>
        {sections.map((s) => (
          <li
            key={s.id}
            className="bg-gray-800 border border-gray-700 rounded-lg p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-white font-medium text-sm">{t('sectionList.encrypted')}</p>
              </div>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <ul className="space-y-2" aria-label={t('sectionList.ariaLabel')}>
        {decrypted.map((s) => (
          <li
            key={s.id}
            className="bg-gray-800 border border-gray-700 rounded-lg p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-white font-medium text-sm">{s.name}</p>
                <p className="text-xs text-gray-400 mt-1">
                  {formatTime(s.startTimeMs)} – {formatTime(s.endTimeMs)}
                </p>
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                <OsuUploadButton
                  difficultyId={difficultyId}
                  sectionId={s.id}
                  mapsetId={mapsetId}
                  role={role}
                  sectionRange={{ start: s.startTimeMs, end: s.endTimeMs }}
                />
                <button
                  type="button"
                  onClick={() => handleDownload(s.id, s.name, s.sortOrder)}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
                >
                  {t('sectionList.downloadOsu')}
                </button>
                <button
                  type="button"
                  onClick={() => setHistorySectionId(s.id)}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
                >
                  {t('sectionList.versionHistory')}
                </button>
                {onEdit && (
                  <button
                    type="button"
                    onClick={() => onEdit(s)}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
                  >
                    {t('sectionList.edit')}
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {historySectionId && (
        <OsuVersionHistory
          difficultyId={difficultyId}
          sectionId={historySectionId}
          onClose={() => setHistorySectionId(null)}
        />
      )}
    </>
  );
}
