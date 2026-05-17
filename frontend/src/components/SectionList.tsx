import { useEffect, useState, useCallback } from 'react';
import type { Section } from '../api/endpoints';
import { downloadSectionOsu } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { decrypt, decodeJsonEnvelope, sectionFieldAad, sectionOsuVersionAad } from '../utils/crypto';
import { logger } from '../utils/logger';
import OsuUploadButton from './OsuUploadButton';
import OsuVersionHistory from './OsuVersionHistory';

interface SectionListProps {
  sections: Section[];
  mapsetId: string;
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
}

export default function SectionList({ sections, mapsetId, difficultyId, onEdit, onDecrypted, role }: SectionListProps) {
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
    async (sectionId: string, sectionName: string) => {
      if (!unlocked) return;
      try {
        const key = await getKey(mapsetId);
        if (!key) return;
        const resp = await downloadSectionOsu(difficultyId, sectionId);
        const plaintext = await decrypt(key, resp.encrypted_content, sectionOsuVersionAad(resp.id, mapsetId));
        const blob = new Blob([plaintext], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${sectionName.replace(/[^a-z0-9]/gi, '_')}.osu`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        logger.warn(`Failed to download section ${sectionId}:`, err);
      }
    },
    [difficultyId, mapsetId, unlocked, getKey],
  );

  if (sections.length === 0) {
    return (
      <p className="text-sm text-gray-500 italic">No sections yet.</p>
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
      <ul className="space-y-2" aria-label="Sections">
        {sections.map((s) => (
          <li
            key={s.id}
            className="bg-gray-800 border border-gray-700 rounded-lg p-3"
          >
            <p className="text-red-400 font-medium text-sm">Failed to decrypt section</p>
          </li>
        ))}
      </ul>
    );
  }

  const items = unlocked ? decrypted : sections.map((s) => ({
    id: s.id,
    name: '🔒 Encrypted Section' as const,
    startTimeMs: null as number | null,
    endTimeMs: null as number | null,
  }));

  return (
    <>
      <ul className="space-y-2" aria-label="Sections">
        {items.map((s) => (
          <li
            key={s.id}
            className="bg-gray-800 border border-gray-700 rounded-lg p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-white font-medium text-sm">{s.name}</p>
                {s.startTimeMs !== null && s.endTimeMs !== null && (
                  <p className="text-xs text-gray-400 mt-1">
                    {formatTime(s.startTimeMs)} – {formatTime(s.endTimeMs)}
                  </p>
                )}
              </div>
              {unlocked && (
                <div className="flex flex-col gap-1 shrink-0">
                  <OsuUploadButton
                    difficultyId={difficultyId}
                    sectionId={s.id}
                    mapsetId={mapsetId}
                    role={role}
                  />
                  <button
                    type="button"
                    onClick={() => handleDownload(s.id, s.name)}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
                  >
                    Download .osu
                  </button>
                  <button
                    type="button"
                    onClick={() => setHistorySectionId(s.id)}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
                  >
                    Version History
                  </button>
                  {onEdit && (
                    <button
                      type="button"
                      onClick={() => {
                        const ds = decrypted.find((d) => d.id === s.id);
                        if (ds) onEdit(ds);
                      }}
                      className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
                    >
                      Edit
                    </button>
                  )}
                </div>
              )}
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
