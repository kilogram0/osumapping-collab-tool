/**
 * Redistribute hit objects between sections when a section is shortened or
 * deleted.
 *
 * Why this exists: a section's .osu blob holds whichever hit objects were in
 * it the last time someone uploaded for that section. Shortening or deleting
 * the section does not by itself touch those objects. Without redistribution
 * the objects past the new boundary are silent data loss: they're still in
 * storage but the merge engine (osuMerge §3) now clips them out, since
 * another section owns that time range. We pre-empt the loss by moving the
 * stray objects into the section that will now cover that range.
 */

import axios from 'axios';
import {
  downloadSectionOsu,
  uploadSectionOsu,
  type UploadSectionOsuPayload,
} from '../api/endpoints';
import {
  decrypt,
  encrypt,
  sectionOsuVersionAad,
} from './crypto';
import {
  parseSections,
  parseHitObjects,
  parseTimingPoints,
  isNegativeTimingPoint,
  stringifySections,
} from './osuParser';

/**
 * Partition a section's hit objects at `cutoffMs`: objects strictly before
 * the cutoff are kept (returned in `remainingContent`), objects at or after
 * the cutoff are returned as raw lines in `movedRaws`. Headers and timing
 * points are untouched — partitioning of negative (inherited / SV) timing
 * points is done separately by `splitNegativeTimingPointsAtTime`.
 */
export function splitSectionAtTime(
  content: string,
  cutoffMs: number,
): { remainingContent: string; movedRaws: string[] } {
  const sections = parseSections(content);
  const ho = sections.find((s) => s.name === 'HitObjects');
  if (!ho) return { remainingContent: content, movedRaws: [] };
  const parsed = parseHitObjects(ho.lines);
  const kept: typeof parsed = [];
  const moved: string[] = [];
  for (const obj of parsed) {
    if (obj.time >= cutoffMs) moved.push(obj.raw);
    else kept.push(obj);
  }
  ho.lines = kept.map((o) => o.raw);
  return { remainingContent: stringifySections(sections), movedRaws: moved };
}

/**
 * Partition a section's negative (inherited / SV-change) timing points at
 * `cutoffMs`: negatives strictly before the cutoff are kept (in
 * `remainingContent`), negatives at or after the cutoff are returned as raw
 * lines in `movedRaws`. Positive (uninherited / BPM) timing points are
 * always kept — those belong to the base, not the section.
 *
 * Why this exists: like hit objects, negative timing points are scoped to a
 * section's [startTimeMs, endTimeMs) range by the merge engine. Shortening
 * or deleting a section without migrating them is silent data loss (see
 * osuMerge.ts §2: "Section timing points (all, positive and negative)").
 */
export function splitNegativeTimingPointsAtTime(
  content: string,
  cutoffMs: number,
): { remainingContent: string; movedRaws: string[] } {
  const sections = parseSections(content);
  const tp = sections.find((s) => s.name === 'TimingPoints');
  if (!tp) return { remainingContent: content, movedRaws: [] };
  const parsed = parseTimingPoints(tp.lines);
  const keptRaws: string[] = [];
  const movedRaws: string[] = [];
  for (const point of parsed) {
    if (isNegativeTimingPoint(point) && point.time >= cutoffMs) {
      movedRaws.push(point.raw);
    } else {
      keptRaws.push(point.raw);
    }
  }
  tp.lines = keptRaws;
  return { remainingContent: stringifySections(sections), movedRaws };
}

/**
 * Insert the supplied raw hit-object lines into the [HitObjects] block of
 * `content` and re-sort by time. Existing hit objects are preserved
 * verbatim. A missing [HitObjects] block is created.
 *
 * Dedupes by (time, trimmed-raw) so the function is idempotent on retry:
 * if the caller's upload chain partially succeeded (e.g. the next-section
 * upload landed but the source-section upload failed), re-running with the
 * same `addedRaws` won't duplicate objects in the destination.
 */
export function mergeHitObjectsInto(content: string, addedRaws: string[]): string {
  if (addedRaws.length === 0) return content;
  const sections = parseSections(content);
  let ho = sections.find((s) => s.name === 'HitObjects');
  if (!ho) {
    ho = { name: 'HitObjects', lines: [] };
    sections.push(ho);
  }
  const combined = [...parseHitObjects(ho.lines), ...parseHitObjects(addedRaws)];
  const seen = new Set<string>();
  const deduped: typeof combined = [];
  for (const obj of combined) {
    const key = `${obj.time}|${obj.raw.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(obj);
  }
  deduped.sort((a, b) => a.time - b.time);
  ho.lines = deduped.map((o) => o.raw);
  return stringifySections(sections);
}

/**
 * Insert the supplied raw timing-point lines into the [TimingPoints] block
 * of `content` and re-sort by time. Existing timing points are preserved
 * verbatim. A missing [TimingPoints] block is created. Any non-negative
 * (uninherited / BPM) lines in `addedRaws` are silently dropped — positives
 * belong to the base, not the section (see osuMerge.ts §2).
 *
 * Dedupes by (time, trimmed-raw) for the same idempotency reason as
 * `mergeHitObjectsInto`: a partially-succeeded redistribute retry must not
 * duplicate negatives in the destination.
 */
export function mergeNegativeTimingPointsInto(content: string, addedRaws: string[]): string {
  const addedNegatives = parseTimingPoints(addedRaws).filter(isNegativeTimingPoint);
  if (addedNegatives.length === 0) return content;
  const sections = parseSections(content);
  let tp = sections.find((s) => s.name === 'TimingPoints');
  if (!tp) {
    tp = { name: 'TimingPoints', lines: [] };
    sections.push(tp);
  }
  const combined = [...parseTimingPoints(tp.lines), ...addedNegatives];
  const seen = new Set<string>();
  const deduped: typeof combined = [];
  for (const point of combined) {
    const key = `${point.time}|${point.raw.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(point);
  }
  deduped.sort((a, b) => a.time - b.time);
  tp.lines = deduped.map((p) => p.raw);
  return stringifySections(sections);
}

/**
 * Returns `true` if the section has an active .osu version on the server,
 * `false` if it has never had one (404). Throws for any other error.
 *
 * Used by the delete guard: the final section may be deleted when it has no
 * blob, since there is no data to lose.
 */
export async function hasSectionOsu(
  difficultyId: string,
  sectionId: string,
): Promise<boolean> {
  try {
    await downloadSectionOsu(difficultyId, sectionId);
    return true;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return false;
    throw err;
  }
}

async function fetchActiveSectionContent(
  difficultyId: string,
  sectionId: string,
  mapsetId: string,
  key: CryptoKey,
): Promise<string | null> {
  try {
    const resp = await downloadSectionOsu(difficultyId, sectionId);
    return await decrypt(
      key,
      resp.encrypted_content,
      sectionOsuVersionAad(resp.id, mapsetId),
    );
  } catch (err) {
    // 404 = no .osu has ever been uploaded for this section.
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

async function uploadNewSectionVersion(
  difficultyId: string,
  sectionId: string,
  mapsetId: string,
  key: CryptoKey,
  content: string,
): Promise<void> {
  const versionId = crypto.randomUUID();
  const encrypted_content = await encrypt(
    key,
    content,
    sectionOsuVersionAad(versionId, mapsetId),
  );
  const payload: UploadSectionOsuPayload = { id: versionId, encrypted_content };
  await uploadSectionOsu(difficultyId, sectionId, payload);
}

/**
 * Move hit objects and negative timing points past `newEndMs` from the
 * shortened section into the next section's content. No-op when the source
 * has no active .osu, or when nothing (HOs or negative TPs) sits past the
 * cutoff. The next section may have no .osu yet — treated as an empty
 * container built from the source's headers.
 */
export async function redistributeForShorten(params: {
  difficultyId: string;
  mapsetId: string;
  sourceSectionId: string;
  nextSectionId: string;
  newEndMs: number;
  key: CryptoKey;
}): Promise<{ movedCount: number }> {
  const { difficultyId, mapsetId, sourceSectionId, nextSectionId, newEndMs, key } = params;

  const sourceContent = await fetchActiveSectionContent(difficultyId, sourceSectionId, mapsetId, key);
  if (sourceContent === null) return { movedCount: 0 };

  const { remainingContent: afterHo, movedRaws: hoMoved } = splitSectionAtTime(sourceContent, newEndMs);
  const { remainingContent: sourceRemaining, movedRaws: tpMoved } = splitNegativeTimingPointsAtTime(afterHo, newEndMs);
  if (hoMoved.length === 0 && tpMoved.length === 0) return { movedCount: 0 };

  // The next section may have no .osu yet; treat that as an empty container.
  const nextContent = await fetchActiveSectionContent(difficultyId, nextSectionId, mapsetId, key);
  let nextUpdated = nextContent ?? buildEmptySectionShell(sourceContent);
  nextUpdated = mergeHitObjectsInto(nextUpdated, hoMoved);
  nextUpdated = mergeNegativeTimingPointsInto(nextUpdated, tpMoved);

  // Parallel uploads: the two writes are independent. If one fails the
  // other may still land, but mergeHitObjectsInto / mergeNegativeTimingPointsInto
  // are dedupe-idempotent and splitSectionAtTime / splitNegativeTimingPointsAtTime
  // are naturally idempotent (items past the cutoff either are or aren't there),
  // so a retry recovers without double-moving.
  await Promise.all([
    uploadNewSectionVersion(difficultyId, sourceSectionId, mapsetId, key, sourceRemaining),
    uploadNewSectionVersion(difficultyId, nextSectionId, mapsetId, key, nextUpdated),
  ]);
  return { movedCount: hoMoved.length };
}

/**
 * Move all hit objects and negative timing points from the deleted section
 * into the next section's content. No-op when the source has no active
 * .osu, or has neither hit objects nor negative timing points to migrate.
 */
export async function redistributeForDelete(params: {
  difficultyId: string;
  mapsetId: string;
  deletedSectionId: string;
  nextSectionId: string;
  key: CryptoKey;
}): Promise<{ movedCount: number }> {
  const { difficultyId, mapsetId, deletedSectionId, nextSectionId, key } = params;

  const sourceContent = await fetchActiveSectionContent(difficultyId, deletedSectionId, mapsetId, key);
  if (sourceContent === null) return { movedCount: 0 };

  const sourceSections = parseSections(sourceContent);
  const sourceHo = sourceSections.find((s) => s.name === 'HitObjects');
  const hoMoved = sourceHo ? parseHitObjects(sourceHo.lines).map((o) => o.raw) : [];
  const sourceTp = sourceSections.find((s) => s.name === 'TimingPoints');
  const tpMoved = sourceTp
    ? parseTimingPoints(sourceTp.lines).filter(isNegativeTimingPoint).map((p) => p.raw)
    : [];
  if (hoMoved.length === 0 && tpMoved.length === 0) return { movedCount: 0 };

  const nextContent = await fetchActiveSectionContent(difficultyId, nextSectionId, mapsetId, key);
  let nextUpdated = nextContent ?? buildEmptySectionShell(sourceContent);
  nextUpdated = mergeHitObjectsInto(nextUpdated, hoMoved);
  nextUpdated = mergeNegativeTimingPointsInto(nextUpdated, tpMoved);
  await uploadNewSectionVersion(difficultyId, nextSectionId, mapsetId, key, nextUpdated);
  return { movedCount: hoMoved.length };
}

/**
 * Merge all hit objects and negative timing points from `sourceSectionId`
 * (the section being absorbed) into `targetSectionId` (the section being
 * kept). No-op when the source has no active .osu, or has neither hit
 * objects nor negative timing points to migrate. If the target has no .osu
 * yet, an empty shell is created from the source's headers before merging.
 */
export async function redistributeForMerge(params: {
  difficultyId: string;
  mapsetId: string;
  targetSectionId: string;
  sourceSectionId: string;
  key: CryptoKey;
}): Promise<{ movedCount: number }> {
  const { difficultyId, mapsetId, targetSectionId, sourceSectionId, key } = params;

  const sourceContent = await fetchActiveSectionContent(difficultyId, sourceSectionId, mapsetId, key);
  if (sourceContent === null) return { movedCount: 0 };

  const sourceSections = parseSections(sourceContent);
  const sourceHo = sourceSections.find((s) => s.name === 'HitObjects');
  const hoMoved = sourceHo ? parseHitObjects(sourceHo.lines).map((o) => o.raw) : [];
  const sourceTp = sourceSections.find((s) => s.name === 'TimingPoints');
  const tpMoved = sourceTp
    ? parseTimingPoints(sourceTp.lines).filter(isNegativeTimingPoint).map((p) => p.raw)
    : [];
  if (hoMoved.length === 0 && tpMoved.length === 0) return { movedCount: 0 };

  const targetContent = await fetchActiveSectionContent(difficultyId, targetSectionId, mapsetId, key);
  let targetUpdated = targetContent ?? buildEmptySectionShell(sourceContent);
  targetUpdated = mergeHitObjectsInto(targetUpdated, hoMoved);
  targetUpdated = mergeNegativeTimingPointsInto(targetUpdated, tpMoved);
  await uploadNewSectionVersion(difficultyId, targetSectionId, mapsetId, key, targetUpdated);
  return { movedCount: hoMoved.length };
}

/**
 * Build an empty-hit-objects clone of a section using another section's
 * headers as a template. Used when the destination section has never had a
 * .osu uploaded — the resulting blob carries valid headers, an empty
 * [TimingPoints] block, and an empty [HitObjects] block ready to receive
 * the migrated lines.
 */
function buildEmptySectionShell(templateContent: string): string {
  const sections = parseSections(templateContent);
  for (const s of sections) {
    if (s.name === 'HitObjects') s.lines = [];
    if (s.name === 'TimingPoints') s.lines = [];
  }
  return stringifySections(sections);
}
