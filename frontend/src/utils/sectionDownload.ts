/**
 * Assemble a single section into a self-contained, playable .osu file by
 * merging it with the active base (headers + positive BPM timing points).
 *
 * A section's stored `encrypted_content` is intentionally sparse — the base
 * carries the BPM timing points and headers per SPECIFICATION.md §4. A bare
 * section download is therefore not opens-in-editor-valid; merging fixes it.
 *
 * Falls back to the raw section content when no active base exists yet
 * (e.g. a difficulty that has never received a .osu upload).
 */

import axios from 'axios';
import { downloadBaseOsu, downloadSectionOsu } from '../api/endpoints';
import {
  decrypt,
  difficultyBaseOsuVersionAad,
  sectionOsuVersionAad,
} from './crypto';
import { mergeOsu } from './osuMerge';
import { sortSections } from './sectionOrder';
import { parseOsuFile, parseMetadata, withMetadataVersion, type OsuMetadata } from './osuParser';
import { logger } from './logger';

export interface AssembledSection {
  /** Merged .osu plaintext, ready to write. */
  content: string;
  /** Parsed [Metadata] from the assembled content (artist/title/version). */
  metadata: OsuMetadata;
  /** Section version number that was downloaded. */
  sectionVersion: number;
  /** Active base version number, or null if no base history exists. */
  baseVersion: number | null;
}

export async function assembleSectionOsu(params: {
  difficultyId: string;
  sectionId: string;
  mapsetId: string;
  key: CryptoKey;
  sortOrder?: number;
  /** Override the [Metadata] Version line on the assembled output. */
  versionOverride?: string;
}): Promise<AssembledSection> {
  const { difficultyId, sectionId, mapsetId, key, sortOrder = 0, versionOverride } = params;

  const sectionResp = await downloadSectionOsu(difficultyId, sectionId);
  const sectionPlaintext = await decrypt(
    key,
    sectionResp.encrypted_content,
    sectionOsuVersionAad(sectionResp.id, mapsetId),
  );

  let merged: string;
  let baseVersion: number | null = null;
  try {
    const baseResp = await downloadBaseOsu(difficultyId);
    const basePlaintext = await decrypt(
      key,
      baseResp.encrypted_content,
      difficultyBaseOsuVersionAad(baseResp.id, mapsetId),
    );
    baseVersion = baseResp.version ?? null;
    merged = mergeOsu(basePlaintext, [
      { content: sectionPlaintext, sortOrder, sectionId },
    ]);
  } catch (err) {
    // 404 = no base history yet; emit the section as-is.
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      merged = sectionPlaintext;
    } else {
      throw err;
    }
  }

  let finalContent = merged;
  let metadata: OsuMetadata;
  if (versionOverride !== undefined) {
    const rewritten = withMetadataVersion(parseOsuFile(merged), versionOverride);
    finalContent = rewritten.content;
    metadata = rewritten.metadata;
  } else {
    metadata = parseMetadata(parseOsuFile(merged));
  }

  return {
    content: finalContent,
    metadata,
    sectionVersion: sectionResp.version,
    baseVersion,
  };
}

export interface AssembledFullOsu {
  /** Active base merged with every section's active .osu. */
  content: string;
  /** Decrypted active base plaintext (pre-merge), for callers that need to
   *  rewrite and re-upload it (e.g. keeping bookmarks in sync). */
  basePlaintext: string;
  /** Active base version number, or null if the base payload omitted it. */
  baseVersion: number | null;
}

/**
 * Assemble the complete difficulty .osu: the active base merged with every
 * section's active .osu, with each section's hit objects clipped to its
 * [startTimeMs, endTimeMs) range.
 *
 * Start times are derived from sort order assuming gapless sections — each
 * section starts where the previous one ended — matching the timeline view in
 * MapsetPage. The final section is end-inclusive so an object exactly at the
 * song end survives. Sections whose blob fails to download are skipped and
 * logged, tolerating a partially-uploaded difficulty.
 *
 * Throws if no active base exists (404) — assembly needs the base for headers
 * and BPM timing. Callers that may run before any base upload should guard.
 */
export async function assembleFullOsu(params: {
  difficultyId: string;
  mapsetId: string;
  key: CryptoKey;
  /** Decrypted per-section metadata. `endTimeMs` drives clipping; `sortOrder`
   *  the merge-precedence and the gapless start-time derivation. */
  sections: { id: string; sortOrder: number; endTimeMs: number }[];
}): Promise<AssembledFullOsu> {
  const { difficultyId, mapsetId, key, sections } = params;

  const baseResp = await downloadBaseOsu(difficultyId);
  const basePlaintext = await decrypt(
    key,
    baseResp.encrypted_content,
    difficultyBaseOsuVersionAad(baseResp.id, mapsetId),
  );

  type Draft = { id: string; content: string; sortOrder: number; endTimeMs: number };
  // Fetch + decrypt sections in parallel; a section whose blob fails is
  // skipped (logged) rather than sinking the whole assembly. Order doesn't
  // matter — sortSections re-orders deterministically below.
  const settled = await Promise.all(
    sections.map(async (section): Promise<Draft | null> => {
      try {
        const resp = await downloadSectionOsu(difficultyId, section.id);
        const content = await decrypt(
          key,
          resp.encrypted_content,
          sectionOsuVersionAad(resp.id, mapsetId),
        );
        return { id: section.id, content, sortOrder: section.sortOrder, endTimeMs: section.endTimeMs };
      } catch (err) {
        logger.warn(`Failed to fetch section ${section.id} for assembly:`, err);
        return null;
      }
    }),
  );
  const drafts = settled.filter((d): d is Draft => d !== null);

  const sorted = sortSections(drafts);
  let runningStart = 0;
  const inputs = sorted.map((d, idx) => {
    const startTimeMs = runningStart;
    runningStart = d.endTimeMs;
    return {
      content: d.content,
      sortOrder: d.sortOrder,
      sectionId: d.id,
      startTimeMs,
      endTimeMs: d.endTimeMs,
      endInclusive: idx === sorted.length - 1,
    };
  });

  return { content: mergeOsu(basePlaintext, inputs), basePlaintext, baseVersion: baseResp.version ?? null };
}
