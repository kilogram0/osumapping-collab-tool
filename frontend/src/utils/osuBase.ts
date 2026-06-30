/**
 * osu! base diff engine.
 *
 * Compares a candidate base against the active base and classifies
 * differences into Critical / Notice / Ignored buckets.
 *
 * Also provides `normalizeFromBase` for the role-based upload paths
 * (rewrite the section so the chosen buckets match the active base).
 */

import { parseSections, OsuSection, stringifySections, parseTimingPoints, isPositiveTimingPoint, type TimingPoint } from './osuParser';

export interface DiffReport {
  critical: string[];
  notice: string[];
  /**
   * Field-level (candidate, active) pairs keyed by the same identifier
   * strings as `critical` / `notice` — used to render "base vs yours" in
   * the modal. Only populated for keyed (`key:value`) fields; line-list
   * fields (`Events`, `TimingPoints`) have no entry here.
   */
  values: Record<string, { candidate: string | null; active: string | null }>;
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
  values: Record<string, { candidate: string | null; active: string | null }>,
): string[] {
  const diffs: string[] = [];
  const allKeys = new Set([...candidate.keys(), ...active.keys()]);
  for (const key of allKeys) {
    const c = candidate.get(key);
    const a = active.get(key);
    if (c !== a) {
      const field = `${prefix}${key}`;
      diffs.push(field);
      values[field] = { candidate: c ?? null, active: a ?? null };
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
 * Timing-significant fields of a timing point: offset, beat length, meter, and
 * the uninherited flag. These define the map's *timing and structure* — a
 * positive (uninherited) point that disagrees with the base on any of them is a
 * genuine BPM/timing conflict and stays critical.
 *
 * Deliberately excluded: `sampleSet`, `sampleIndex`, `volume`, and `effects`.
 * The first three are the hitsounding group and volume; `effects` is the
 * kiai / omit-barline flags. All are per-difficulty cosmetic settings, not
 * shared timing, so a positive point that differs *only* in them is a
 * whitelisted change that does NOT trip the critical modal. This is safe for
 * any point the uploaded section actually carries: on download the merge
 * engine lets a section's positive point win over the base's at the same
 * offset, so the mapper's change reaches the final map even though the base
 * isn't promoted. A full-difficulty upload carries every positive; a
 * single-section upload only carries those inside its [startMs, endMs) range,
 * so a cosmetic change to an out-of-range positive is dropped rather than
 * promoted — acceptable, since cross-section timing is the base's concern.
 */
function timingSignature(tp: TimingPoint): string {
  return [tp.time, tp.beatLength, tp.meter, tp.uninherited].join(',');
}

/**
 * True if two [TimingPoints] line lists differ on any timing-significant field
 * (see {@link timingSignature}) — i.e. the difference is more than a hitsounding
 * group / volume change and so warrants the critical modal. A change in the
 * count or order of the points is always treated as a critical difference.
 */
function timingPointsCriticallyDiffer(candidateLines: string[], activeLines: string[]): boolean {
  // Positive (uninherited / BPM) points only. Inherited (negative) points are
  // per-section slider velocity and are excluded from the base comparison
  // (SPECIFICATION.md §8). The active base contains only positives by
  // construction, but filtering here makes the function honor that contract
  // regardless of what it is handed.
  const candidate = parseTimingPoints(candidateLines).filter(isPositiveTimingPoint);
  const active = parseTimingPoints(activeLines).filter(isPositiveTimingPoint);
  if (candidate.length !== active.length) return true;
  for (let i = 0; i < candidate.length; i++) {
    if (timingSignature(candidate[i]) !== timingSignature(active[i])) return true;
  }
  return false;
}

/**
 * Diff a candidate base against the active base.
 *
 * Buckets (per SPECIFICATION.md §8):
 * - **Critical**: every key/value in `[Difficulty]`; `AudioFilename` in
 *   `[General]`; `[TimingPoints]` (positive lines — the base only contains
 *   uninherited points by construction).
 * - **Notice**: rest of `[General]`, `[Events]`, `[Metadata]` (except `Version`).
 * - **Ignored**: `[Metadata] Version`, `[Colours]`, `[Editor]`, pre-header line.
 *
 * Any per-key field diff also gets an entry in `values` so the UI can
 * render "base vs yours" rows.
 */
export function diffBase(candidateBase: string, activeBase: string): DiffReport {
  const candidate = parseSections(candidateBase);
  const active = parseSections(activeBase);
  const values: Record<string, { candidate: string | null; active: string | null }> = {};

  // --- Critical bucket ---
  const candidateDifficulty = getSection(candidate, 'Difficulty');
  const activeDifficulty = getSection(active, 'Difficulty');
  const candidateDiffMap = getKeyValueMap(candidateDifficulty?.lines ?? []);
  const activeDiffMap = getKeyValueMap(activeDifficulty?.lines ?? []);
  const critical = diffMaps(candidateDiffMap, activeDiffMap, 'Difficulty:', values);

  const candidateGeneral = getSection(candidate, 'General');
  const activeGeneral = getSection(active, 'General');
  const candidateGenMap = getKeyValueMap(candidateGeneral?.lines ?? []);
  const activeGenMap = getKeyValueMap(activeGeneral?.lines ?? []);
  const candAudio = candidateGenMap.get('AudioFilename');
  const actAudio = activeGenMap.get('AudioFilename');
  if (candAudio !== actAudio) {
    critical.push('General:AudioFilename');
    values['General:AudioFilename'] = { candidate: candAudio ?? null, active: actAudio ?? null };
  }

  // TimingPoints (positive only — buildCandidateBase already filtered the
  // candidate; the active base contains only positives by construction).
  // Compared on timing-significant fields only, so a positive point that
  // changed only its hitsounding group / volume / effects (kiai) is
  // whitelisted (see timingPointsCriticallyDiffer). Line-list comparison, so
  // no per-key entry in `values`.
  const candidateTiming = getSection(candidate, 'TimingPoints');
  const activeTiming = getSection(active, 'TimingPoints');
  if (timingPointsCriticallyDiffer(candidateTiming?.lines ?? [], activeTiming?.lines ?? [])) {
    critical.push('TimingPoints');
  }

  // --- Notice bucket ---
  const noticeGenCand = new Map(candidateGenMap);
  noticeGenCand.delete('AudioFilename');
  const noticeGenAct = new Map(activeGenMap);
  noticeGenAct.delete('AudioFilename');
  const notice = diffMaps(noticeGenCand, noticeGenAct, 'General:', values);

  const candidateMetadata = getSection(candidate, 'Metadata');
  const activeMetadata = getSection(active, 'Metadata');
  const candidateMetaMap = getKeyValueMap(candidateMetadata?.lines ?? []);
  const activeMetaMap = getKeyValueMap(activeMetadata?.lines ?? []);
  candidateMetaMap.delete('Version');
  activeMetaMap.delete('Version');
  notice.push(...diffMaps(candidateMetaMap, activeMetaMap, 'Metadata:', values));

  const candidateEvents = getSection(candidate, 'Events');
  const activeEvents = getSection(active, 'Events');
  const candidateEventLines = getDataLines(candidateEvents?.lines ?? []);
  const activeEventLines = getDataLines(activeEvents?.lines ?? []);
  if (!arraysEqual(candidateEventLines, activeEventLines)) {
    notice.push('Events');
  }

  const hasDiff = critical.length > 0 || notice.length > 0;

  return {
    critical,
    notice,
    values,
    hasDiff,
  };
}

/**
 * Rewrite the section so the requested buckets match the active base.
 *
 * - `critical: true` rewrites `[Difficulty]` keys, `[General] AudioFilename`,
 *   and `[TimingPoints]` positive lines (the section's inherited / negative
 *   timing points are preserved; positives are taken from the active base
 *   and reinserted in time order).
 * - `notice: true` rewrites the rest of `[General]`, `[Metadata]` (except
 *   `Version`), and replaces the data lines of `[Events]` wholesale with
 *   the active base's.
 *
 * Only existing key/value lines are rewritten — keys missing from the
 * section are not added back, and keys missing from the base are left
 * unchanged. This mirrors the diff semantics (we surface missing keys via
 * the diff so they can be fixed at the source) and keeps the function
 * idempotent.
 */
export function normalizeFromBase(
  sectionContent: string,
  activeBase: string,
  scope: { critical: boolean; notice: boolean },
): string {
  // No-op fast path: parse/stringify is not strictly lossless (a leading
  // blank line can grow on roundtrip), so callers that pass an all-off
  // scope (e.g. defensive `normalizeFromBase(x, base, scope)` where
  // scope happens to be empty) deserve to get their input back verbatim
  // rather than a structurally-equivalent-but-byte-different string.
  if (!scope.critical && !scope.notice) {
    return sectionContent;
  }

  const section = parseSections(sectionContent);
  const base = parseSections(activeBase);

  const baseDiffMap = getKeyValueMap(getSection(base, 'Difficulty')?.lines ?? []);
  const baseGenMap = getKeyValueMap(getSection(base, 'General')?.lines ?? []);
  const baseMetaMap = getKeyValueMap(getSection(base, 'Metadata')?.lines ?? []);
  baseMetaMap.delete('Version');
  const baseEventsLines = getSection(base, 'Events')?.lines ?? [];
  const baseTpLines = getSection(base, 'TimingPoints')?.lines ?? [];

  for (const sec of section) {
    if (sec.name === 'Difficulty' && scope.critical) {
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
        if (!kv) return line;
        if (scope.critical && kv.key === 'AudioFilename' && baseGenMap.has('AudioFilename')) {
          return `AudioFilename:${baseGenMap.get('AudioFilename')}`;
        }
        if (scope.notice && kv.key !== 'AudioFilename' && baseGenMap.has(kv.key)) {
          return `${kv.key}:${baseGenMap.get(kv.key)}`;
        }
        return line;
      });
    } else if (sec.name === 'Metadata' && scope.notice) {
      sec.lines = sec.lines.map((line) => {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('//')) return line;
        const kv = parseKeyValue(line);
        if (kv && kv.key !== 'Version' && baseMetaMap.has(kv.key)) {
          return `${kv.key}:${baseMetaMap.get(kv.key)}`;
        }
        return line;
      });
    } else if (sec.name === 'Events' && scope.notice) {
      // Whole-section replace: events are a line list, there's no
      // per-key mapping to do. Use the base's events verbatim.
      sec.lines = [...baseEventsLines];
    } else if (sec.name === 'TimingPoints' && scope.critical) {
      // Replace positives (uninherited) with the base's positives, keep
      // the section's inherited / negative points. Reinsert in time
      // order so the file remains chronologically sorted; tie-break by
      // priority so a positive at offset T sits before a negative at
      // the same offset (osu! convention — uninherited establishes the
      // BPM/timing, inherited then modifies SV from that point).
      // Lines that fail to parse as timing points are dropped:
      // [TimingPoints] has a fixed grammar, so anything unparseable is
      // junk that doesn't belong here, and we have no defensible place
      // to put it in the sorted output anyway.
      type TpRow = { line: string; time: number; priority: number };
      const sectionRows: TpRow[] = [];
      for (const line of sec.lines) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('//')) continue;
        const tp = parseTimingPoints([line]);
        if (tp.length === 0) continue;
        if (!isPositiveTimingPoint(tp[0])) {
          sectionRows.push({ line, time: tp[0].time, priority: 1 });
        }
        // Section positives are dropped — base's positives replace them.
      }
      const baseRows: TpRow[] = [];
      for (const line of baseTpLines) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('//')) continue;
        const tp = parseTimingPoints([line]);
        if (tp.length === 0) continue;
        if (isPositiveTimingPoint(tp[0])) {
          baseRows.push({ line, time: tp[0].time, priority: 0 });
        }
      }
      const merged = [...baseRows, ...sectionRows].sort((a, b) => {
        if (a.time !== b.time) return a.time - b.time;
        return a.priority - b.priority;
      });
      sec.lines = merged.map((r) => r.line);
    }
  }

  return stringifySections(section);
}

/**
 * Convenience wrapper kept for the mapper-critical confirmation path.
 * Equivalent to `normalizeFromBase(content, base, { critical: true, notice: false })`.
 */
export function normalizeCriticalLines(sectionContent: string, activeBase: string): string {
  return normalizeFromBase(sectionContent, activeBase, { critical: true, notice: false });
}
