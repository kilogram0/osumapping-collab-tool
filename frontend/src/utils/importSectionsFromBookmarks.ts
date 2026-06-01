/**
 * Shared core of bookmark-based section import.
 *
 * Used by three call sites — the standalone Import Bookmarks button, the
 * Create Difficulty modal, and the Create Mapset modal — each of which used
 * to reimplement the same parse → bookmarks → boundaries → loop(encrypt,
 * createSection, slice, uploadSectionOsu) sequence. Keeping the loop here
 * means future changes (the no-base-history rule, naming, sort-order
 * offsets) land in one place.
 *
 * Pre-population safety: when {@link ImportSectionsParams.prepopulate} is
 * true, the helper bundles a base version with the first section upload and
 * pre-populates every section's first .osu version with a sliced copy of
 * `parsed`. The caller MUST verify the difficulty has no base history
 * before passing `prepopulate: true` — otherwise re-activating an older
 * base later would conflict with the slices created here.
 */

import {
  encrypt,
  sectionFieldAad,
  sectionOsuVersionAad,
  difficultyBaseOsuVersionAad,
} from './crypto';
import {
  parseBookmarks,
  filterBookmarksByMinGap,
  MIN_SECTION_LENGTH_MS,
  bookmarksToSectionBoundaries,
  buildCandidateBase,
  withBookmarks,
  sliceForSection,
  parseOsuFile,
  type ParsedOsuFile,
} from './osuParser';
import { sectionNameForIndex } from './sectionNaming';
import { createSection, uploadSectionOsu } from '../api/endpoints';

export interface ImportSectionsParams {
  /** Already-parsed source .osu file. */
  parsed: ParsedOsuFile;
  /** Active mapset key (decrypted, in-memory). */
  key: CryptoKey;
  /** Mapset UUID — folded into AAD for every encrypted field. */
  mapsetId: string;
  /** Difficulty UUID to import sections into. Must already exist server-side. */
  difficultyId: string;
  /** Song length in ms; used to add an outro section (last bookmark → end). */
  songLengthMs: number | null;
  /** Pre-populate each section's first .osu version + a base version.
   *  Caller must verify the difficulty has no base history (see file docstring). */
  prepopulate: boolean;
  /** Sort order assigned to the first imported section. Subsequent sections
   *  get startingSortOrder + 1, +2, … and share the same index for their
   *  default names (S{order+1}) so a second import on the same difficulty
   *  doesn't collide with the first import's S1, S2, …. */
  startingSortOrder: number;
}

export interface ImportSectionsResult {
  /** Sections created (and pre-populated, if requested) successfully. */
  created: number;
  /** Total sections derived from bookmarks. 0 when none were found / derivable. */
  total: number;
  /** Null on full success; otherwise a short human-readable failure reason. */
  error: string | null;
}

export async function importSectionsFromBookmarks(
  params: ImportSectionsParams,
): Promise<ImportSectionsResult> {
  const { parsed, key, mapsetId, difficultyId, songLengthMs, prepopulate, startingSortOrder } = params;

  const bookmarks = parseBookmarks(parsed);
  if (bookmarks.length === 0) {
    return { created: 0, total: 0, error: 'No bookmarks found in the [Editor] section of this .osu file.' };
  }

  // Drop bookmarks that would produce sub-second sections (greedy, anchored at
  // the song start). Shared across every creation path — the standalone Import
  // Bookmarks button, Create Difficulty, and Create Mapset (.osz) — since they
  // all funnel through here.
  const spacedBookmarks = filterBookmarksByMinGap(bookmarks, MIN_SECTION_LENGTH_MS, songLengthMs);

  const boundaries = bookmarksToSectionBoundaries(spacedBookmarks, songLengthMs);
  if (boundaries.length === 0) {
    return { created: 0, total: 0, error: 'Could not derive any sections from the bookmarks.' };
  }

  // Bundle a base version with the first section upload (only when this is
  // a virgin difficulty). Encrypt it once outside the loop.
  let bundledBase: { id: string; encrypted_content: string } | null = null;
  if (prepopulate) {
    try {
      const baseVersionId = crypto.randomUUID();
      // Write the *filtered* bookmarks into the base, not the raw ones: min-gap
      // filtering may have dropped some, and the base's bookmarks must match the
      // sections actually created (see withBookmarks).
      const baseContent = withBookmarks(parseOsuFile(buildCandidateBase(parsed)), spacedBookmarks);
      const encBase = await encrypt(
        key,
        baseContent,
        difficultyBaseOsuVersionAad(baseVersionId, mapsetId),
      );
      bundledBase = { id: baseVersionId, encrypted_content: encBase };
    } catch (err) {
      return {
        created: 0,
        total: boundaries.length,
        error: err instanceof Error ? err.message : 'Failed to encrypt base template',
      };
    }
  }

  let created = 0;
  for (let i = 0; i < boundaries.length; i++) {
    const { startMs, endMs } = boundaries[i];
    const sectionId = crypto.randomUUID();
    const order = startingSortOrder + i;
    const sectionName = sectionNameForIndex(order);

    try {
      const [encName, encStart, encEnd, encSort] = await Promise.all([
        encrypt(key, sectionName, sectionFieldAad(sectionId, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: startMs }), sectionFieldAad(sectionId, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: endMs }), sectionFieldAad(sectionId, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: order }), sectionFieldAad(sectionId, mapsetId)),
      ]);
      await createSection(difficultyId, {
        id: sectionId,
        encrypted_name: encName,
        encrypted_start_time_ms: encStart,
        encrypted_end_time_ms: encEnd,
        encrypted_sort_order: encSort,
      });

      if (prepopulate) {
        const sliceContent = sliceForSection(parsed, startMs, endMs);
        const sectionVersionId = crypto.randomUUID();
        const encSection = await encrypt(
          key,
          sliceContent,
          sectionOsuVersionAad(sectionVersionId, mapsetId),
        );
        // Bundle base only with the very first section upload; later
        // uploads omit it since one base version now exists for this diff.
        await uploadSectionOsu(difficultyId, sectionId, {
          id: sectionVersionId,
          encrypted_content: encSection,
          base_version: i === 0 ? bundledBase : null,
        });
      }

      created++;
    } catch (err) {
      return {
        created,
        total: boundaries.length,
        error: err instanceof Error ? err.message : 'Failed to create section',
      };
    }
  }

  return { created, total: boundaries.length, error: null };
}
