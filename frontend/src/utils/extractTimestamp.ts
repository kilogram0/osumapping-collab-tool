/**
 * Extract the first valid osu! timestamp from a plaintext string.
 *
 * Supported format: `MM:SS:MMM` or `MM:SS:MMM (combos)`
 * Example: `00:46:140 (2,3,4)`
 *
 * Returns `null` if no timestamp is found.
 */
export interface ExtractedTimestamp {
  ms: number;
  combos?: string;
}

export function extractFirstTimestamp(content: string): ExtractedTimestamp | null {
  const pattern = /(\d{2}):(\d{2}):(\d{3})(?:\s+(\([^)]+\)))?/;
  const match = content.match(pattern);
  if (!match) return null;

  const [, minutes, seconds, milliseconds, combos] = match;
  const totalMs = parseInt(minutes, 10) * 60000 + parseInt(seconds, 10) * 1000 + parseInt(milliseconds, 10);
  return { ms: totalMs, combos };
}

/**
 * Find all timestamps in a string and return their match data.
 * Used for linkifying every timestamp in a post body.
 */
export interface TimestampMatch {
  ms: number;
  combos?: string;
  raw: string;
  index: number;
}

export function findAllTimestamps(content: string): TimestampMatch[] {
  const pattern = /(\d{2}):(\d{2}):(\d{3})(?:\s+(\([^)]+\)))?/g;
  const matches: TimestampMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const [, minutes, seconds, milliseconds, combos] = match;
    const ms = parseInt(minutes, 10) * 60000 + parseInt(seconds, 10) * 1000 + parseInt(milliseconds, 10);
    matches.push({ ms, combos, raw: match[0], index: match.index });
  }
  return matches;
}

/**
 * Generate an `osu://edit/` link from a millisecond value and optional combo string.
 */
export function generateOsuLink(ms: number, combos?: string): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = ms % 1000;

  const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(milliseconds).padStart(3, '0')}`;

  if (combos) {
    return `osu://edit/${timeStr}%20${encodeURIComponent(combos)}`;
  }
  return `osu://edit/${timeStr}`;
}

/**
 * Format milliseconds as `MM:SS:MMM` for display.
 */
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = ms % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(milliseconds).padStart(3, '0')}`;
}

const STRICT_TIMESTAMP_REGEX = /^(\d{2}):(\d{2}):(\d{3})$/;

/**
 * Parse a strict `MM:SS:MMM` timestamp string into milliseconds.
 * Returns `null` if the format is invalid.
 */
export function parseTimestampString(input: string): { ms: number } | null {
  const match = input.trim().match(STRICT_TIMESTAMP_REGEX);
  if (!match) return null;

  const [, minutes, seconds, milliseconds] = match;
  const min = parseInt(minutes, 10);
  const sec = parseInt(seconds, 10);
  const ms = parseInt(milliseconds, 10);

  if (sec > 59) return null;

  return { ms: min * 60_000 + sec * 1_000 + ms };
}
