/**
 * Compose .osu filenames in the canonical osu! format:
 *
 *   Artist - SongName (Mapset Name) [DiffName].osu
 *
 * Each piece is sanitized for cross-platform filesystem safety (strip
 * `\ / : * ? " < > |`, collapse whitespace). Missing pieces fall back to
 * neutral placeholders so the output is always well-formed.
 */

/** Replace filesystem-unsafe characters and collapse whitespace. */
export function sanitizeFilenamePart(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface OsuFilenameParts {
  artist: string | null | undefined;
  title: string | null | undefined;
  mapsetTitle: string | null | undefined;
  diffName: string | null | undefined;
}

/**
 * Build a filename like `Artist - SongName (Mapset Name) [DiffName].osu`.
 * The `.osu` suffix is included.
 */
export function composeOsuFilename(parts: OsuFilenameParts): string {
  const artist = sanitizeFilenamePart(parts.artist) || 'Unknown Artist';
  const title = sanitizeFilenamePart(parts.title) || 'Unknown Song';
  const mapsetTitle = sanitizeFilenamePart(parts.mapsetTitle) || 'Mapset';
  const diffName = sanitizeFilenamePart(parts.diffName) || 'Difficulty';
  return `${artist} - ${title} (${mapsetTitle}) [${diffName}].osu`;
}
