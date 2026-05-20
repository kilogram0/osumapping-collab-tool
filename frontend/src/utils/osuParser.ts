/**
 * osu! beatmap file parser.
 *
 * All .osu parsing, base generation, diffing, and merging happen client-side.
 * The backend is a dumb encrypted blob store.
 */

export interface OsuSection {
  name: string;
  lines: string[];
}

export interface TimingPoint {
  time: number;
  beatLength: number;
  meter: number;
  sampleSet: number;
  sampleIndex: number;
  volume: number;
  uninherited: number;
  effects: number;
  raw: string;
}

export interface HitObject {
  x: number;
  y: number;
  time: number;
  type: number;
  hitSound: number;
  extras: string;
  raw: string;
}

export interface ParsedOsuFile {
  sections: OsuSection[];
  timingPointsSection: OsuSection | null;
  hitObjectsSection: OsuSection | null;
  timingPoints: TimingPoint[];
  hitObjects: HitObject[];
}

export const MAX_OSU_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_SIZE_BYTES = MAX_OSU_BYTES;

/**
 * Validate that the .osu file meets basic requirements.
 * Returns an error string if invalid, or null if valid.
 */
export function validateOsuFile(content: string): string | null {
  const byteLength = new TextEncoder().encode(content).length;
  if (byteLength > MAX_SIZE_BYTES) {
    return `File size (${byteLength} bytes) exceeds maximum allowed (${MAX_SIZE_BYTES} bytes)`;
  }

  if (!content.includes('[HitObjects]')) {
    return 'Missing [HitObjects] section';
  }

  return null;
}

/**
 * Parse a .osu file into structured sections, timing points, and hit objects.
 * Throws if the file fails validation.
 */
export function parseOsuFile(content: string): ParsedOsuFile {
  const validationError = validateOsuFile(content);
  if (validationError) {
    throw new Error(validationError);
  }

  const sections = parseSections(content);
  const timingPointsSection = sections.find((s) => s.name === 'TimingPoints') ?? null;
  const hitObjectsSection = sections.find((s) => s.name === 'HitObjects') ?? null;

  const timingPoints = timingPointsSection ? parseTimingPoints(timingPointsSection.lines) : [];
  const hitObjects = hitObjectsSection ? parseHitObjects(hitObjectsSection.lines) : [];

  return {
    sections,
    timingPointsSection,
    hitObjectsSection,
    timingPoints,
    hitObjects,
  };
}

/**
 * Split the raw .osu text into bracket-identified sections.
 * Lines outside any section are collected under the empty name ''
 * so that the file-format header (e.g. 'osu file format v14')
 * is preserved for reconstruction.
 */
export function parseSections(content: string): OsuSection[] {
  const lines = content.split(/\r?\n/);
  const sections: OsuSection[] = [];
  let current: OsuSection = { name: '', lines: [] };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      if (current.lines.length > 0 || current.name !== '') {
        sections.push(current);
      }
      current = { name: trimmed.slice(1, -1), lines: [] };
    } else {
      current.lines.push(line);
    }
  }

  if (current.lines.length > 0 || current.name !== '') {
    sections.push(current);
  }

  return sections;
}

/**
 * Parse timing-point lines into structured objects.
 * Malformed lines are skipped.
 */
export function parseTimingPoints(lines: string[]): TimingPoint[] {
  const points: TimingPoint[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;

    const parts = trimmed.split(',');
    if (parts.length < 2) continue;

    const time = parseFloat(parts[0]);
    const beatLength = parseFloat(parts[1]);
    if (!Number.isFinite(time) || !Number.isFinite(beatLength)) continue;

    const meterVal = parseInt(parts[2] ?? '4', 10);
    const sampleSetVal = parseInt(parts[3] ?? '0', 10);
    const sampleIndexVal = parseInt(parts[4] ?? '0', 10);
    const volumeVal = parseInt(parts[5] ?? '0', 10);
    const uninheritedVal = parseInt(parts[6] ?? '1', 10);
    const effectsVal = parseInt(parts[7] ?? '0', 10);

    points.push({
      time,
      beatLength,
      meter: Number.isNaN(meterVal) ? 4 : meterVal,
      sampleSet: Number.isNaN(sampleSetVal) ? 0 : sampleSetVal,
      sampleIndex: Number.isNaN(sampleIndexVal) ? 0 : sampleIndexVal,
      volume: Number.isNaN(volumeVal) ? 0 : volumeVal,
      uninherited: Number.isNaN(uninheritedVal) ? 1 : uninheritedVal,
      effects: Number.isNaN(effectsVal) ? 0 : effectsVal,
      raw,
    });
  }
  return points;
}

/**
 * Parse hit-object lines into structured objects.
 * Malformed lines are skipped.
 */
export function parseHitObjects(lines: string[]): HitObject[] {
  const objects: HitObject[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;

    const parts = trimmed.split(',');
    if (parts.length < 5) continue;

    const x = parseFloat(parts[0]);
    const y = parseFloat(parts[1]);
    const time = parseFloat(parts[2]);
    const type = parseInt(parts[3], 10);
    const hitSound = parseInt(parts[4], 10);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(time)) continue;

    const extras = parts.slice(5).join(',');

    objects.push({
      x,
      y,
      time,
      type,
      hitSound,
      extras,
      raw,
    });
  }
  return objects;
}

/**
 * True if the timing point represents an uninherited (BPM) point.
 * Both the explicit `uninherited` flag and a positive `beatLength` indicate this.
 */
export function isPositiveTimingPoint(tp: TimingPoint): boolean {
  return tp.uninherited === 1 || tp.beatLength > 0;
}

/**
 * True if the timing point represents an inherited (slider velocity) point.
 */
export function isNegativeTimingPoint(tp: TimingPoint): boolean {
  return tp.uninherited === 0 || tp.beatLength < 0;
}

/**
 * Reassemble a .osu file from its parsed sections.
 * Useful for rewriting specific sections while preserving everything else.
 */
export function stringifySections(sections: OsuSection[]): string {
  return sections
    .map((section) => {
      if (section.name === '') {
        return section.lines.join('\n');
      }
      return `[${section.name}]\n${section.lines.join('\n')}`;
    })
    .join('\n\n');
}

export interface OsuMetadata {
  artist: string | null;
  title: string | null;
  version: string | null;
}

/**
 * Read Artist, Title, and Version from the [Metadata] section.
 * Returns null for fields that are absent or empty.
 */
export function parseMetadata(parsed: ParsedOsuFile): OsuMetadata {
  const meta = parsed.sections.find((s) => s.name === 'Metadata');
  if (!meta) return { artist: null, title: null, version: null };

  function readKey(key: string): string | null {
    for (const line of meta!.lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(`${key}:`)) continue;
      const value = trimmed.slice(key.length + 1).trim();
      return value || null;
    }
    return null;
  }

  return {
    artist: readKey('Artist'),
    title: readKey('Title'),
    version: readKey('Version'),
  };
}

/**
 * Return a new .osu string with the [Metadata] Version line replaced by
 * `Version:<newVersion>`. If no Version line exists, one is appended at
 * the end of the [Metadata] section. If no [Metadata] section exists, the
 * input is returned unchanged — this is a permissive utility, not a validator.
 *
 * Returns the rewritten content and the post-rewrite metadata in one pass
 * so callers don't have to reparse just to read Artist/Title for filename use.
 */
export function withMetadataVersion(
  parsed: ParsedOsuFile,
  newVersion: string,
): { content: string; metadata: OsuMetadata } {
  let artist: string | null = null;
  let title: string | null = null;
  const next: OsuSection[] = parsed.sections.map((section) => {
    if (section.name !== 'Metadata') return section;
    let replaced = false;
    const lines = section.lines.map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('Version:')) {
        replaced = true;
        return `Version:${newVersion}`;
      }
      if (trimmed.startsWith('Artist:')) {
        artist = trimmed.slice('Artist:'.length).trim() || null;
      } else if (trimmed.startsWith('Title:')) {
        title = trimmed.slice('Title:'.length).trim() || null;
      }
      return line;
    });
    if (!replaced) lines.push(`Version:${newVersion}`);
    return { name: 'Metadata', lines };
  });
  return {
    content: stringifySections(next),
    metadata: { artist, title, version: newVersion },
  };
}

/**
 * Read the difficulty name from the [Metadata] Version: line of a .osu file.
 * Returns null when missing or empty. This mirrors osu! editor semantics where
 * "Version" is the difficulty label (e.g. "Hard", "Insane").
 */
export function parseDifficultyName(parsed: ParsedOsuFile): string | null {
  const meta = parsed.sections.find((s) => s.name === 'Metadata');
  if (!meta) return null;
  for (const line of meta.lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('Version:')) continue;
    const value = trimmed.slice('Version:'.length).trim();
    return value || null;
  }
  return null;
}

/**
 * Parse bookmarks from the [Editor] section of a .osu file.
 * Returns an array of timestamps in milliseconds, sorted ascending.
 */
export function parseBookmarks(parsed: ParsedOsuFile): number[] {
  const editorSection = parsed.sections.find((s) => s.name === 'Editor');
  if (!editorSection) return [];

  for (const line of editorSection.lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('Bookmarks:')) continue;
    const value = trimmed.slice('Bookmarks:'.length).trim();
    if (!value) return [];
    return value
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0)
      .sort((a, b) => a - b);
  }
  return [];
}

export interface SectionBoundary {
  startMs: number;
  endMs: number;
}

/**
 * Convert a list of bookmark timestamps into section boundaries.
 *
 * Each bookmark is treated as a section boundary. Sections are created
 * between consecutive bookmarks, plus an optional intro (0 → first bookmark)
 * and an optional outro (last bookmark → songLengthMs).
 */
export function bookmarksToSectionBoundaries(
  bookmarks: number[],
  songLengthMs?: number | null,
): SectionBoundary[] {
  if (bookmarks.length === 0) return [];

  const sorted = [...bookmarks].sort((a, b) => a - b);
  const boundaries: SectionBoundary[] = [];

  if (sorted[0] > 0) {
    boundaries.push({ startMs: 0, endMs: sorted[0] });
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i + 1] > sorted[i]) {
      boundaries.push({ startMs: sorted[i], endMs: sorted[i + 1] });
    }
  }

  if (songLengthMs != null && songLengthMs > sorted[sorted.length - 1]) {
    boundaries.push({ startMs: sorted[sorted.length - 1], endMs: songLengthMs });
  }

  return boundaries;
}

/**
 * Parse a break-event line from [Events]. Returns null if the line is not a
 * break (event-type code "2"). Break format: `2,startMs,endMs`.
 */
function parseBreakEvent(line: string): { start: number; end: number } | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('//')) return null;
  const parts = trimmed.split(',');
  if (parts.length < 3) return null;
  if (parts[0].trim() !== '2') return null;
  const start = parseInt(parts[1].trim(), 10);
  const end = parseInt(parts[2].trim(), 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

export interface SectionFilterCounts {
  hitObjects: number;
  timingPoints: number;
  breaks: number;
}

interface FilterResult {
  sections: OsuSection[];
  dropped: SectionFilterCounts;
}

/**
 * Internal: apply [startMs, endMs) filtering to TimingPoints, HitObjects, and
 * [Events] break entries. Returns the filtered section list plus per-category
 * drop counts so callers can show a "trimmed N objects" summary.
 *
 * Break rule (per user-supplied requirement): a break is kept only if **both**
 * its start and end fall inside [startMs, endMs). Either endpoint outside ⇒ drop.
 */
function filterSectionsByRange(
  parsed: ParsedOsuFile,
  startMs: number,
  endMs: number,
): FilterResult {
  const dropped: SectionFilterCounts = { hitObjects: 0, timingPoints: 0, breaks: 0 };

  const sections: OsuSection[] = parsed.sections.map((section) => {
    if (section.name === 'TimingPoints') {
      const lines = section.lines.filter((line) => {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('//')) return true;
        const tp = parseTimingPoints([line]);
        if (tp.length === 0) return false;
        const t = tp[0].time;
        const keep = t >= startMs && t < endMs;
        if (!keep) dropped.timingPoints++;
        return keep;
      });
      return { name: 'TimingPoints', lines };
    }
    if (section.name === 'HitObjects') {
      const lines = section.lines.filter((line) => {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('//')) return true;
        const ho = parseHitObjects([line]);
        if (ho.length === 0) return false;
        const t = ho[0].time;
        const keep = t >= startMs && t < endMs;
        if (!keep) dropped.hitObjects++;
        return keep;
      });
      return { name: 'HitObjects', lines };
    }
    if (section.name === 'Events') {
      const lines = section.lines.filter((line) => {
        const br = parseBreakEvent(line);
        if (br === null) return true; // non-break event (background, video, etc.) — keep
        const keep = br.start >= startMs && br.start < endMs && br.end >= startMs && br.end < endMs;
        if (!keep) dropped.breaks++;
        return keep;
      });
      return { name: 'Events', lines };
    }
    return section;
  });

  return { sections, dropped };
}

/**
 * Build a per-section .osu file from a parsed source .osu, keeping only
 * the timing points, hit objects, and [Events] breaks whose timestamps fall
 * inside [startMs, endMs).
 *
 * Headers and the [TimingPoints]/[HitObjects] structure are preserved so the
 * result is a stand-alone, mergeable .osu. The merge engine deduplicates
 * positive timing points across sections vs. base, so it is safe to leave
 * them in each slice — the slice is self-contained.
 *
 * Half-open interval (inclusive start, exclusive end) so that hit objects
 * sitting exactly on a section boundary belong to the later section and
 * never appear in two slices at once.
 */
export function sliceForSection(
  parsed: ParsedOsuFile,
  startMs: number,
  endMs: number,
): string {
  const { sections } = filterSectionsByRange(parsed, startMs, endMs);
  return stringifySections(sections);
}

export interface SanitizeReport {
  /** Sanitized .osu plaintext, ready to encrypt + upload. */
  content: string;
  /** How many lines of each category were dropped. */
  dropped: SectionFilterCounts;
  /** True iff anything was dropped. */
  changed: boolean;
}

/**
 * Sanitize a user-uploaded .osu against a section's [startMs, endMs) range.
 * Identical filtering to {@link sliceForSection}, but also returns counts of
 * what was dropped so callers can surface a confirmation to the user.
 *
 * Why: a mapper may export a full-song .osu from osu! editor and upload it as
 * "their section". Without sanitization, hit objects belonging to other
 * sections would be stored under this section and duplicate on merge.
 */
export function sanitizeSectionUpload(
  parsed: ParsedOsuFile,
  startMs: number,
  endMs: number,
): SanitizeReport {
  const { sections, dropped } = filterSectionsByRange(parsed, startMs, endMs);
  const content = stringifySections(sections);
  const changed = dropped.hitObjects > 0 || dropped.timingPoints > 0 || dropped.breaks > 0;
  return { content, dropped, changed };
}

/**
 * Build a candidate base from a parsed .osu file:
 * 1. Keep everything before [HitObjects] intact.
 * 2. In [TimingPoints]: keep only positive (uninherited / BPM) lines.
 * 3. Leave [HitObjects] empty.
 */
export function buildCandidateBase(parsed: ParsedOsuFile): string {
  const baseSections: OsuSection[] = [];

  for (const section of parsed.sections) {
    if (section.name === 'HitObjects') {
      baseSections.push({ name: 'HitObjects', lines: [''] });
    } else if (section.name === 'TimingPoints') {
      const filtered = section.lines.filter((line) => {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('//')) return true;
        const tp = parseTimingPoints([line]);
        return tp.length > 0 && isPositiveTimingPoint(tp[0]);
      });
      baseSections.push({ name: 'TimingPoints', lines: filtered });
    } else {
      baseSections.push(section);
    }
  }

  return stringifySections(baseSections);
}
