/**
 * osu! merge engine.
 *
 * Assembles a complete, valid .osu file from an active base template and
 * a set of decrypted section .osu files.
 */

import {
  parseSections,
  parseTimingPoints,
  parseHitObjects,
  isPositiveTimingPoint,
  type OsuSection,
} from './osuParser';

export interface SectionInput {
  content: string;
  sortOrder: number;
  sectionId: string;
  /** Inclusive lower bound (ms) for this section's hit objects. When omitted,
   *  hit objects are not filtered by time — the section's full hit-object list
   *  is included. */
  startTimeMs?: number;
  /** Upper bound (ms) for this section's hit objects. By default the bound is
   *  exclusive so adjacent sections don't double-count a boundary object; set
   *  `endInclusive: true` on the final section so an object exactly at the
   *  song end is preserved. */
  endTimeMs?: number;
  endInclusive?: boolean;
}

interface TimingEntry {
  time: number;
  type: 'positive' | 'negative';
  raw: string;
  source: 'base' | { sortOrder: number; sectionId: string };
}

function getTimingPoints(sections: OsuSection[]): TimingEntry[] {
  const tpSection = sections.find((s) => s.name === 'TimingPoints');
  if (!tpSection) return [];
  return parseTimingPoints(tpSection.lines).map((tp) => ({
    time: tp.time,
    type: isPositiveTimingPoint(tp) ? ('positive' as const) : ('negative' as const),
    raw: tp.raw,
    source: 'base' as const,
  }));
}

function shouldReplace(existing: TimingEntry, candidate: TimingEntry): boolean {
  // Section always wins over base.
  if (existing.source === 'base' && candidate.source !== 'base') return true;
  if (existing.source !== 'base' && candidate.source === 'base') return false;
  if (existing.source === 'base' && candidate.source === 'base') return false;

  // Both are sections – lower sort_order wins.
  const ex = existing.source as Exclude<TimingEntry['source'], 'base'>;
  const ca = candidate.source as Exclude<TimingEntry['source'], 'base'>;
  if (ca.sortOrder < ex.sortOrder) return true;
  if (ca.sortOrder > ex.sortOrder) return false;
  // Stable secondary tiebreaker: sectionId lexicographic.
  return ca.sectionId < ex.sectionId;
}

/**
 * Merge an active base and a list of section .osu files into a single
 * valid .osu file.
 *
 * Algorithm (per SPECIFICATION.md §8):
 * 1. Headers come from the base (everything except TimingPoints and HitObjects).
 * 2. TimingPoints are collected from the base (positive only) and every
 *    section (all points), then sorted and deduplicated by (timestamp, type).
 *    Tiebreaker: section > base; lower sort_order > higher; sectionId stable.
 * 3. HitObjects are collected from every section and sorted by time.
 * 4. Output order: headers → [TimingPoints] → [HitObjects].
 */
export function mergeOsu(baseContent: string, sections: SectionInput[]): string {
  const base = parseSections(baseContent);

  // --- 1. Headers (everything from base except TimingPoints and HitObjects) ---
  const headerSections = base.filter(
    (s) => s.name !== 'TimingPoints' && s.name !== 'HitObjects',
  );

  // --- 2. Collect timing points ---
  const timingMap = new Map<string, TimingEntry>();

  // Base timing points (positive only)
  for (const tp of getTimingPoints(base)) {
    if (tp.type === 'positive') {
      const key = `${tp.time}|${tp.type}`;
      timingMap.set(key, tp);
    }
  }

  // Section timing points (all, positive and negative)
  for (const section of sections) {
    const parsed = parseSections(section.content);
    for (const tp of getTimingPoints(parsed)) {
      const key = `${tp.time}|${tp.type}`;
      const candidate: TimingEntry = {
        ...tp,
        source: { sortOrder: section.sortOrder, sectionId: section.sectionId },
      };
      const existing = timingMap.get(key);
      if (!existing || shouldReplace(existing, candidate)) {
        timingMap.set(key, candidate);
      }
    }
  }

  // Sort by time ascending; positive before negative at same time for determinism.
  const mergedTiming = Array.from(timingMap.values()).sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return a.type === 'positive' ? -1 : 1;
  });

  // --- 3. Collect hit objects from every section ---
  // Clip each section's hit objects to its declared [startTimeMs, endTimeMs)
  // range when those bounds are provided. Sections can carry stray objects
  // outside their range — e.g. when a previously-longer section was shortened
  // — and we must not emit those a second time from the adjacent section that
  // now owns that time range.
  const allHitObjects: { time: number; raw: string }[] = [];
  for (const section of sections) {
    const parsed = parseSections(section.content);
    const hoSection = parsed.find((s) => s.name === 'HitObjects');
    if (!hoSection) continue;
    const lo = section.startTimeMs;
    const hi = section.endTimeMs;
    for (const obj of parseHitObjects(hoSection.lines)) {
      if (lo !== undefined && obj.time < lo) continue;
      if (hi !== undefined) {
        if (section.endInclusive ? obj.time > hi : obj.time >= hi) continue;
      }
      allHitObjects.push({ time: obj.time, raw: obj.raw });
    }
  }

  allHitObjects.sort((a, b) => a.time - b.time);

  // --- 4. Assemble ---
  const parts: string[] = [];

  for (const section of headerSections) {
    if (section.name === '') {
      parts.push(section.lines.join('\n'));
    } else {
      parts.push(`[${section.name}]\n${section.lines.join('\n')}`);
    }
  }

  parts.push(`[TimingPoints]\n${mergedTiming.map((t) => t.raw).join('\n')}`);
  parts.push(`[HitObjects]\n${allHitObjects.map((o) => o.raw).join('\n')}`);

  return parts.join('\n\n');
}
