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

const MAX_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB

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
