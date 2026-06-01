/**
 * Re-section an existing difficulty from a fresh set of bookmarks.
 *
 * Unlike {@link importSectionsFromBookmarks} — which *appends* sections and is
 * meant for a difficulty that has none yet — this rebuilds the section layout
 * of a difficulty that already has work. Appending onto a populated difficulty
 * would stack a second layer of sections over the same time ranges, so the
 * merge engine would double-count hit objects and the timing-point tiebreaker
 * would be decided by colliding sort orders. This flow avoids that by:
 *
 *   1. Assembling the current base + sections into one full .osu — the source
 *      of truth for the objects. The uploaded file contributes *only* its
 *      bookmarks; its objects are ignored (a full-diff replacement already has
 *      its own button).
 *   2. Re-slicing that assembled content into new sections at the new
 *      bookmark boundaries, the same way merge/split/delete redistribute
 *      objects rather than dropping them (see sectionRedistribute.ts).
 *   3. Deleting the old sections.
 *
 * The base's headers and BPM timing are kept; only its [Editor] bookmarks are
 * rewritten to the new divisions, so a downloaded base / full diff stays
 * self-describing (its bookmarks always match the sections). That updated base
 * is bundled with the first new section's upload — the only way to mint a new
 * base version (see UploadSectionOsuPayload.base_version).
 *
 * Ordering & atomicity: new sections are created and populated *before* the
 * old ones are deleted, so a mid-flight failure leaves the original data
 * intact (at worst a transient overlap, which the user can resolve by
 * re-running). There is no server-side transaction; this mirrors the
 * non-atomic merge/delete flows already in the app.
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
  sliceForSection,
  withBookmarks,
  parseOsuFile,
  type ParsedOsuFile,
} from './osuParser';
import { sectionNameForIndex } from './sectionNaming';
import { assembleFullOsu } from './sectionDownload';
import { createSection, uploadSectionOsu, deleteSection } from '../api/endpoints';

export interface ResectionParams {
  /** Uploaded .osu, parsed — used ONLY for its bookmarks. */
  parsed: ParsedOsuFile;
  /** Active mapset key (decrypted, in-memory). */
  key: CryptoKey;
  /** Mapset UUID — folded into AAD for every encrypted field. */
  mapsetId: string;
  /** Difficulty UUID being re-sectioned. */
  difficultyId: string;
  /** Song length in ms; used to add an outro section (last bookmark → end). */
  songLengthMs: number | null;
  /** Existing sections (already decrypted) to assemble from and then delete. */
  existingSections: { id: string; sortOrder: number; endTimeMs: number }[];
}

export interface ResectionResult {
  /** New sections created (and populated) successfully. */
  created: number;
  /** Total sections derived from the (gap-filtered) bookmarks. */
  total: number;
  /** Old sections deleted successfully. */
  deleted: number;
  /** Null on full success; otherwise a short human-readable failure reason. */
  error: string | null;
}

export async function resectionFromBookmarks(
  params: ResectionParams,
): Promise<ResectionResult> {
  const { parsed, key, mapsetId, difficultyId, songLengthMs, existingSections } = params;

  // --- 1. Derive the new boundaries (no mutation until this validates). ---
  const bookmarks = parseBookmarks(parsed);
  if (bookmarks.length === 0) {
    return { created: 0, total: 0, deleted: 0, error: 'No bookmarks found in the [Editor] section of this .osu file.' };
  }
  const spaced = filterBookmarksByMinGap(bookmarks, MIN_SECTION_LENGTH_MS, songLengthMs);
  const boundaries = bookmarksToSectionBoundaries(spaced, songLengthMs);
  if (boundaries.length === 0) {
    return { created: 0, total: 0, deleted: 0, error: 'Could not derive any sections at least 1 second long from the bookmarks.' };
  }

  // --- 2. Assemble current content (the object source of truth) and build
  // the updated base: the existing base with its bookmarks rewritten to the
  // new divisions. Encrypt the base once, here, to bundle with section #0. ---
  let assembled: ParsedOsuFile;
  let bundledBase: { id: string; encrypted_content: string };
  try {
    const { content, basePlaintext } = await assembleFullOsu({ difficultyId, mapsetId, key, sections: existingSections });
    assembled = parseOsuFile(content);

    const baseVersionId = crypto.randomUUID();
    const newBaseContent = withBookmarks(parseOsuFile(basePlaintext), spaced);
    const encBase = await encrypt(key, newBaseContent, difficultyBaseOsuVersionAad(baseVersionId, mapsetId));
    bundledBase = { id: baseVersionId, encrypted_content: encBase };
  } catch (err) {
    return {
      created: 0,
      total: boundaries.length,
      deleted: 0,
      error: err instanceof Error ? err.message : 'Failed to assemble current difficulty content',
    };
  }

  // --- 3. Create new sections and populate them from the assembled content.
  // Done before deleting the old sections so a failure here can't lose data. ---
  let created = 0;
  for (let i = 0; i < boundaries.length; i++) {
    const { startMs, endMs } = boundaries[i];
    const sectionId = crypto.randomUUID();
    const sectionName = sectionNameForIndex(i);
    try {
      const [encName, encStart, encEnd, encSort] = await Promise.all([
        encrypt(key, sectionName, sectionFieldAad(sectionId, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: startMs }), sectionFieldAad(sectionId, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: endMs }), sectionFieldAad(sectionId, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: i }), sectionFieldAad(sectionId, mapsetId)),
      ]);
      await createSection(difficultyId, {
        id: sectionId,
        encrypted_name: encName,
        encrypted_start_time_ms: encStart,
        encrypted_end_time_ms: encEnd,
        encrypted_sort_order: encSort,
      });

      const sliceContent = sliceForSection(assembled, startMs, endMs);
      const versionId = crypto.randomUUID();
      const encContent = await encrypt(key, sliceContent, sectionOsuVersionAad(versionId, mapsetId));
      // Bundle the bookmark-updated base with the first upload only; later
      // uploads omit it since one new base version now exists for this diff.
      await uploadSectionOsu(difficultyId, sectionId, {
        id: versionId,
        encrypted_content: encContent,
        base_version: i === 0 ? bundledBase : null,
      });

      created++;
    } catch (err) {
      return {
        created,
        total: boundaries.length,
        deleted: 0,
        error: err instanceof Error ? err.message : 'Failed to create section',
      };
    }
  }

  // --- 4. Delete the old sections. Raw delete (no redistribute): every object
  // already lives in the freshly-built sections, so the cascade that delete
  // normally runs would be redundant and would churn the new layout. ---
  let deleted = 0;
  for (const section of existingSections) {
    try {
      await deleteSection(difficultyId, section.id);
      deleted++;
    } catch (err) {
      return {
        created,
        total: boundaries.length,
        deleted,
        error: err instanceof Error
          ? `Rebuilt ${created} section(s) but failed to remove an old one: ${err.message}`
          : 'Failed to remove an old section',
      };
    }
  }

  return { created, total: boundaries.length, deleted, error: null };
}
