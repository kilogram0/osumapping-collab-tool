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
import { parseOsuFile, parseMetadata, withMetadataVersion, type OsuMetadata } from './osuParser';

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
