/**
 * Keep the active base template's [Editor] bookmarks in lock-step with the
 * section divisions after a structural edit (delete / merge / split / shorten).
 *
 * Why: the base carries the headers a downloaded base / full diff inherits.
 * If its bookmarks drift from the actual sections, anyone opening the file has
 * to manually check whether the bookmarks still mark the section boundaries.
 * Import and re-section already write the divisions into the base; this closes
 * the gap for in-app edits.
 *
 * Owner-only: minting a base version is an owner action server-side (a mapper
 * gets a 403), so callers must gate on ownership. A mapper's end-time edit
 * therefore won't sync the base — an accepted limitation that preserves the
 * owner-only base policy (the server can't verify a "bookmarks-only" change
 * under E2EE).
 */

import { downloadBaseOsu, createBaseOsuVersion } from '../api/endpoints';
import { decrypt, encrypt, difficultyBaseOsuVersionAad } from './crypto';
import { parseOsuFile, parseBookmarks, withBookmarks } from './osuParser';
import { sortSections } from './sectionOrder';

/**
 * Derive the bookmark set (interior section boundaries) from a section list.
 * Sections are gapless from 0, so the divisions are every section's end time
 * except the last (the song end is not a division). Returns ascending,
 * deduplicated, positive timestamps.
 */
export function bookmarksFromSections(
  sections: { id: string; sortOrder: number; endTimeMs: number }[],
): number[] {
  const sorted = sortSections(sections);
  const interior = sorted.slice(0, -1).map((s) => s.endTimeMs);
  return Array.from(new Set(interior.filter((ms) => ms > 0))).sort((a, b) => a - b);
}

function sameNumbers(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Rewrite the active base's bookmarks to match `sections` and upload it as a
 * new base version. No-op (returns false) when the base's bookmarks already
 * match, so repeated edits don't pile up redundant base versions.
 *
 * Throws on network / crypto failure; callers treat the failure as non-fatal
 * (the structural edit itself has already succeeded).
 *
 * Concurrency: read-base → create-version is not atomic, and the server
 * computes the next base version from a non-locked max()+1 (rejecting losers
 * with a 409). Two rapid edits can therefore race — last writer wins, and a
 * loser surfaces as the caller's non-fatal toast. The base bookmarks may then
 * lag a beat behind the latest divisions, which is acceptable: bookmarks are
 * advisory, and import / re-section always rewrite them authoritatively.
 */
export async function syncBaseBookmarks(params: {
  difficultyId: string;
  mapsetId: string;
  key: CryptoKey;
  sections: { id: string; sortOrder: number; endTimeMs: number }[];
}): Promise<boolean> {
  const { difficultyId, mapsetId, key, sections } = params;
  const desired = bookmarksFromSections(sections);

  const baseResp = await downloadBaseOsu(difficultyId);
  const basePlaintext = await decrypt(
    key,
    baseResp.encrypted_content,
    difficultyBaseOsuVersionAad(baseResp.id, mapsetId),
  );
  const parsed = parseOsuFile(basePlaintext);
  if (sameNumbers(parseBookmarks(parsed), desired)) return false;

  const versionId = crypto.randomUUID();
  const newContent = withBookmarks(parsed, desired);
  const encrypted = await encrypt(key, newContent, difficultyBaseOsuVersionAad(versionId, mapsetId));
  await createBaseOsuVersion(difficultyId, { id: versionId, encrypted_content: encrypted });
  return true;
}
