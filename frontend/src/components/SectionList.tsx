import { useEffect, useState } from 'react';
import type { Section } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { decrypt, decodeJsonEnvelope, sectionFieldAad } from '../utils/crypto';
import { logger } from '../utils/logger';

interface SectionListProps {
  sections: Section[];
  mapsetId: string;
}

interface DecryptedSection {
  id: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  sortOrder: number;
}

export default function SectionList({ sections, mapsetId }: SectionListProps) {
  const { isUnlocked, getKey } = useEncryption();
  const [decrypted, setDecrypted] = useState<DecryptedSection[]>([]);
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
              decrypt(key, s.encrypted_name, sectionFieldAad(s.id, mapsetId, 'name')),
              decrypt(key, s.encrypted_start_time_ms, sectionFieldAad(s.id, mapsetId, 'start_time_ms')),
              decrypt(key, s.encrypted_end_time_ms, sectionFieldAad(s.id, mapsetId, 'end_time_ms')),
              decrypt(key, s.encrypted_sort_order, sectionFieldAad(s.id, mapsetId, 'sort_order')),
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
        results.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
        setDecrypted(results);
      }
    }

    decryptAll();
    return () => { cancelled = true; };
  }, [unlocked, sections, mapsetId, getKey]);

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
    const mm = minutes.toString().padStart(2, '0');
    const ss = seconds.toString().padStart(2, '0');
    if (hours > 0) {
      return `${hours}:${mm}:${ss}`;
    }
    return `${mm}:${ss}`;
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
    <ul className="space-y-2" aria-label="Sections">
      {items.map((s) => (
        <li
          key={s.id}
          className="bg-gray-800 border border-gray-700 rounded-lg p-3"
        >
          <p className="text-white font-medium text-sm">{s.name}</p>
          {s.startTimeMs !== null && s.endTimeMs !== null && (
            <p className="text-xs text-gray-400 mt-1">
              {formatTime(s.startTimeMs)} – {formatTime(s.endTimeMs)}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
