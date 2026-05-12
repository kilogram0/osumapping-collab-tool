/**
 * osu! base diff engine.
 *
 * Compares a candidate base against the active base and classifies
 * differences into Critical / Notice / Ignored buckets.
 *
 * Also provides `normalizeCriticalLines` for the mapper-confirmation
 * upload path (rewrite the section so critical lines match the base).
 */

import { parseSections, OsuSection, stringifySections } from './osuParser';

export interface DiffReport {
  critical: string[];
  notice: string[];
  timingPointsChanged: boolean;
  hasDiff: boolean;
}

function parseKeyValue(line: string): { key: string; value: string } | null {
  const idx = line.indexOf(':');
  if (idx === -1) return null;
  return {
    key: line.slice(0, idx).trim(),
    value: line.slice(idx + 1).trim(),
  };
}

function getSection(sections: OsuSection[], name: string): OsuSection | undefined {
  return sections.find((s) => s.name === name);
}

function getKeyValueMap(lines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    const kv = parseKeyValue(line);
    if (kv) map.set(kv.key, kv.value);
  }
  return map;
}

function getDataLines(lines: string[]): string[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//'));
}

function diffMaps(
  candidate: Map<string, string>,
  active: Map<string, string>,
  prefix: string,
): string[] {
  const diffs: string[] = [];
  const allKeys = new Set([...candidate.keys(), ...active.keys()]);
  for (const key of allKeys) {
    if (candidate.get(key) !== active.get(key)) {
      diffs.push(`${prefix}${key}`);
    }
  }
  return diffs;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Diff a candidate base against the active base.
 *
 * Buckets (per SPECIFICATION.md §8):
 * - **Critical**: every key/value in `[Difficulty]`; `AudioFilename` in `[General]`.
 * - **Notice**: rest of `[General]`, `[Events]`, `[Metadata]` (except `Version`).
 * - **Ignored**: `[Metadata] Version`, `[TimingPoints]` (handled separately),
 *   `[Colours]`, `[Editor]`, pre-header line.
 *
 * Timing points are compared independently because a change in positive
 * (uninherited) timing points triggers the same action as a Notice mismatch.
 */
export function diffBase(candidateBase: string, activeBase: string): DiffReport {
  const candidate = parseSections(candidateBase);
  const active = parseSections(activeBase);

  // --- Critical bucket ---
  const candidateDifficulty = getSection(candidate, 'Difficulty');
  const activeDifficulty = getSection(active, 'Difficulty');
  const candidateDiffMap = getKeyValueMap(candidateDifficulty?.lines ?? []);
  const activeDiffMap = getKeyValueMap(activeDifficulty?.lines ?? []);
  const critical = diffMaps(candidateDiffMap, activeDiffMap, 'Difficulty:');

  const candidateGeneral = getSection(candidate, 'General');
  const activeGeneral = getSection(active, 'General');
  const candidateGenMap = getKeyValueMap(candidateGeneral?.lines ?? []);
  const activeGenMap = getKeyValueMap(activeGeneral?.lines ?? []);
  if (candidateGenMap.get('AudioFilename') !== activeGenMap.get('AudioFilename')) {
    critical.push('General:AudioFilename');
  }

  // --- Notice bucket ---
  const noticeGenCand = new Map(candidateGenMap);
  noticeGenCand.delete('AudioFilename');
  const noticeGenAct = new Map(activeGenMap);
  noticeGenAct.delete('AudioFilename');
  const notice = diffMaps(noticeGenCand, noticeGenAct, 'General:');

  const candidateMetadata = getSection(candidate, 'Metadata');
  const activeMetadata = getSection(active, 'Metadata');
  const candidateMetaMap = getKeyValueMap(candidateMetadata?.lines ?? []);
  const activeMetaMap = getKeyValueMap(activeMetadata?.lines ?? []);
  candidateMetaMap.delete('Version');
  activeMetaMap.delete('Version');
  notice.push(...diffMaps(candidateMetaMap, activeMetaMap, 'Metadata:'));

  const candidateEvents = getSection(candidate, 'Events');
  const activeEvents = getSection(active, 'Events');
  const candidateEventLines = getDataLines(candidateEvents?.lines ?? []);
  const activeEventLines = getDataLines(activeEvents?.lines ?? []);
  if (!arraysEqual(candidateEventLines, activeEventLines)) {
    notice.push('Events');
  }

  // --- TimingPoints (positive only, since that's what the base contains) ---
  const candidateTiming = getSection(candidate, 'TimingPoints');
  const activeTiming = getSection(active, 'TimingPoints');
  const candidateTpLines = getDataLines(candidateTiming?.lines ?? []);
  const activeTpLines = getDataLines(activeTiming?.lines ?? []);
  const timingPointsChanged = !arraysEqual(candidateTpLines, activeTpLines);
  if (timingPointsChanged) {
    notice.push('TimingPoints');
  }

  const hasDiff = critical.length > 0 || notice.length > 0;

  return {
    critical,
    notice,
    timingPointsChanged,
    hasDiff,
  };
}

/**
 * Rewrite a full .osu section file so that its critical lines match the
 * active base. Used in the mapper-confirmation upload path.
 *
 * Critical lines rewritten:
 * - `[Difficulty]`: every key/value line
 * - `[General]`: `AudioFilename` only
 *
 * All other sections and lines are preserved verbatim.
 */
export function normalizeCriticalLines(
  sectionContent: string,
  activeBase: string,
): string {
  const section = parseSections(sectionContent);
  const base = parseSections(activeBase);

  const baseDiffMap = getKeyValueMap(getSection(base, 'Difficulty')?.lines ?? []);
  const baseGenMap = getKeyValueMap(getSection(base, 'General')?.lines ?? []);

  for (const sec of section) {
    if (sec.name === 'Difficulty') {
      sec.lines = sec.lines.map((line) => {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('//')) return line;
        const kv = parseKeyValue(line);
        if (kv && baseDiffMap.has(kv.key)) {
          return `${kv.key}:${baseDiffMap.get(kv.key)}`;
        }
        return line;
      });
    } else if (sec.name === 'General') {
      sec.lines = sec.lines.map((line) => {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('//')) return line;
        const kv = parseKeyValue(line);
        if (kv && kv.key === 'AudioFilename' && baseGenMap.has('AudioFilename')) {
          return `AudioFilename:${baseGenMap.get('AudioFilename')}`;
        }
        return line;
      });
    }
  }

  return stringifySections(section);
}
