import { useEffect, useRef, useState } from 'react';
import type { DifficultyDetail, Mapset, Post, Section } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import {
  decrypt,
  decodeJsonEnvelope,
  mapsetFieldAad,
  postFieldAad,
  sectionFieldAad,
  sectionOsuVersionAad,
} from '../utils/crypto';
import { extractFirstTimestamp } from '../utils/extractTimestamp';
import { logger } from '../utils/logger';
import { downloadSectionOsu } from '../api/endpoints';
import { parseOsuFile } from '../utils/osuParser';
import { isAxiosError } from 'axios';
import type { DecryptedPost, DecryptedSection } from '../types';

interface CacheEntry<T> {
  key: string;
  value: T;
}

/** Cheap cache key: id + updated_at already changes whenever ciphertext changes. */
function buildMetadataCacheKey(mapset: Mapset | undefined): string {
  if (!mapset) return '';
  return `${mapset.id}:${mapset.updated_at}`;
}

/** Cheap cache key: id + updated_at already changes whenever ciphertext changes. */
function buildSectionsCacheKey(sections: Section[] | undefined): string {
  if (!sections) return '';
  return sections.map((s) => `${s.id}:${s.updated_at}`).join('|');
}

/** Cheap cache key: id + updated_at already changes whenever ciphertext changes. */
function buildPostsCacheKey(posts: Post[] | undefined): string {
  if (!posts) return '';
  return posts.map((p) => `${p.id}:${p.updated_at}`).join('|');
}

/**
 * Decrypt a mapset's metadata (description + song length) once per mapset.
 * Results are memoised so switching difficulties inside the same mapset does
 * not re-decrypt the mapset header.
 */
export function useDecryptedMetadata(
  mapset: Mapset | undefined,
  mapsetId: string,
  unlocked: boolean,
): { description: string | null; songLengthMs: number | null } {
  const { getKey } = useEncryption();
  const [description, setDescription] = useState<string | null>(null);
  const [songLengthMs, setSongLengthMs] = useState<number | null>(null);
  const cacheRef = useRef<Map<string, CacheEntry<{ description: string | null; songLengthMs: number | null }>>>(new Map());

  useEffect(() => {
    if (!unlocked || !mapset) {
      setDescription(null);
      setSongLengthMs(null);
      return;
    }

    const cacheKey = buildMetadataCacheKey(mapset);
    const cached = cacheRef.current.get(mapset.id);
    if (cached?.key === cacheKey) {
      setDescription(cached.value.description);
      setSongLengthMs(cached.value.songLengthMs);
      return;
    }

    let cancelled = false;
    const m = mapset;

    async function decryptMetadata() {
      try {
        const key = await getKey(mapsetId);
        if (!key || cancelled) return;

        const results = await Promise.allSettled([
          m.encrypted_description
            ? decrypt(key, m.encrypted_description, mapsetFieldAad(mapsetId))
            : Promise.resolve(null),
          decrypt(key, m.encrypted_song_length_ms, mapsetFieldAad(mapsetId)),
        ]);

        if (cancelled) return;

        const descResult = results[0];
        const songResult = results[1];

        const nextDescription = descResult.status === 'fulfilled' ? descResult.value : null;
        const nextSongLengthMs =
          songResult.status === 'fulfilled' ? decodeJsonEnvelope(songResult.value) : null;

        setDescription(nextDescription);
        setSongLengthMs(nextSongLengthMs);

        // Only cache successful decrypts; transient failures should retry next render.
        if (results.every((r) => r.status === 'fulfilled')) {
          cacheRef.current.set(m.id, {
            key: cacheKey,
            value: { description: nextDescription, songLengthMs: nextSongLengthMs },
          });
        }
      } catch (err) {
        logger.warn('Failed to decrypt mapset metadata:', err);
      }
    }

    decryptMetadata();
    return () => { cancelled = true; };
  }, [unlocked, mapset, mapsetId, getKey]);

  return { description, songLengthMs };
}

/**
 * Decrypt the sections of a difficulty with memoisation per difficulty.
 * Switching away from a difficulty and back reuses the cached plaintext
 * instead of re-running AES-GCM.
 */
export function useDecryptedSections(
  difficultyDetail: DifficultyDetail | undefined,
  mapsetId: string,
  unlocked: boolean,
): DecryptedSection[] {
  const { getKey } = useEncryption();
  const [decryptedSections, setDecryptedSections] = useState<DecryptedSection[]>([]);
  const cacheRef = useRef<Map<string, CacheEntry<DecryptedSection[]>>>(new Map());

  useEffect(() => {
    if (!unlocked || !difficultyDetail?.sections) {
      setDecryptedSections([]);
      return;
    }

    const difficultyId = difficultyDetail.id;
    const sections = difficultyDetail.sections;
    const cacheKey = buildSectionsCacheKey(sections);
    const cached = cacheRef.current.get(difficultyId);
    if (cached?.key === cacheKey) {
      setDecryptedSections(cached.value);
      return;
    }

    let cancelled = false;

    async function decryptSections() {
      try {
        const key = await getKey(mapsetId);
        if (!key || cancelled) return;

        const results: DecryptedSection[] = [];
        await Promise.all(
          sections.map(async (s) => {
            try {
              const aad = sectionFieldAad(s.id, mapsetId);
              const [name, endRaw, sortRaw] = await Promise.all([
                decrypt(key, s.encrypted_name, aad),
                decrypt(key, s.encrypted_end_time_ms, aad),
                decrypt(key, s.encrypted_sort_order, aad),
              ]);
              results.push({
                id: s.id,
                name,
                startTimeMs: 0,
                endTimeMs: decodeJsonEnvelope(endRaw),
                sortOrder: decodeJsonEnvelope(sortRaw),
                assignedTo: s.assigned_to,
              });
            } catch (_err) {
              logger.warn(`Failed to decrypt section ${s.id}:`, _err);
            }
          }),
        );

        if (!cancelled) {
          results.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));

          let runningStart = 0;
          const derived = results.map((s) => {
            const section = { ...s, startTimeMs: runningStart };
            runningStart = s.endTimeMs;
            return section;
          });

          cacheRef.current.set(difficultyId, { key: cacheKey, value: derived });
          setDecryptedSections(derived);
        }
      } catch (err) {
        logger.warn('Failed to decrypt sections:', err);
      }
    }

    decryptSections();
    return () => { cancelled = true; };
  }, [unlocked, difficultyDetail, mapsetId, getKey]);

  return decryptedSections;
}

/**
 * Decrypt the posts of a difficulty with memoisation per difficulty.
 */
export function useDecryptedPosts(
  difficultyDetail: DifficultyDetail | undefined,
  mapsetId: string,
  unlocked: boolean,
): DecryptedPost[] {
  const { getKey } = useEncryption();
  const [decryptedPosts, setDecryptedPosts] = useState<DecryptedPost[]>([]);
  const cacheRef = useRef<Map<string, CacheEntry<DecryptedPost[]>>>(new Map());

  useEffect(() => {
    if (!unlocked || !difficultyDetail?.posts) {
      setDecryptedPosts([]);
      return;
    }

    const difficultyId = difficultyDetail.id;
    const posts = difficultyDetail.posts;
    const cacheKey = buildPostsCacheKey(posts);
    const cached = cacheRef.current.get(difficultyId);
    if (cached?.key === cacheKey) {
      setDecryptedPosts(cached.value);
      return;
    }

    let cancelled = false;

    async function decryptPosts() {
      try {
        const key = await getKey(mapsetId);
        if (!key || cancelled) return;

        const results: DecryptedPost[] = await Promise.all(
          posts.map(async (post): Promise<DecryptedPost> => {
            try {
              const plaintext = await decrypt(key, post.encrypted_body, postFieldAad(post.id, mapsetId));
              const extracted = extractFirstTimestamp(plaintext);
              return {
                ...post,
                decryptedBody: plaintext,
                extractedMs: extracted?.ms ?? null,
              };
            } catch (_err) {
              logger.warn(`Failed to decrypt post ${post.id}:`, _err);
              return {
                ...post,
                decryptedBody: '[Failed to decrypt]',
                extractedMs: null,
              };
            }
          }),
        );

        if (!cancelled) {
          cacheRef.current.set(difficultyId, { key: cacheKey, value: results });
          setDecryptedPosts(results);
        }
      } catch (err) {
        logger.warn('Failed to decrypt posts:', err);
      }
    }

    decryptPosts();
    return () => { cancelled = true; };
  }, [unlocked, difficultyDetail, mapsetId, getKey]);

  return decryptedPosts;
}

/**
 * Background scan: download + parse each section's active .osu to determine
 * whether it contains hit objects within the section's own time range. Results
 * are cached per section range so range edits invalidate only the affected
 * section, and switching difficulties reuses prior scan results.
 */
export function useSectionHitObjectScan(
  decryptedSections: DecryptedSection[],
  selectedDifficultyId: string | null,
  mapsetId: string,
  unlocked: boolean,
): Map<string, boolean> {
  const { getKey } = useEncryption();
  const [sectionHitObjectMap, setSectionHitObjectMap] = useState<Map<string, boolean>>(new Map());
  const cacheRef = useRef<Map<string, boolean>>(new Map());

  // Clear the in-memory cache whenever the difficulty changes so stale results
  // from a previous difficulty never bleed through.
  useEffect(() => {
    cacheRef.current = new Map();
    setSectionHitObjectMap(new Map());
  }, [selectedDifficultyId]);

  useEffect(() => {
    if (!decryptedSections.length || !selectedDifficultyId || !unlocked) return;

    const makeKey = (s: DecryptedSection) => `${s.id}:${s.startTimeMs}:${s.endTimeMs}`;
    const sectionsToScan = decryptedSections.filter((s) => !cacheRef.current.has(makeKey(s)));
    if (!sectionsToScan.length) return;

    const difficultyId = selectedDifficultyId;
    let cancelled = false;

    async function scanHitObjects() {
      const key = await getKey(mapsetId);
      if (!key || cancelled) return;

      const updates = new Map<string, boolean>();
      const tasks = sectionsToScan.map((section) => async () => {
        try {
          const resp = await downloadSectionOsu(difficultyId, section.id);
          const plaintext = await decrypt(key, resp.encrypted_content, sectionOsuVersionAad(resp.id, mapsetId));
          const parsed = parseOsuFile(plaintext);
          const hasInRange = parsed.hitObjects.some(
            (ho) => ho.time >= section.startTimeMs && ho.time < section.endTimeMs,
          );
          updates.set(section.id, hasInRange);
          cacheRef.current.set(makeKey(section), hasInRange);
        } catch (err) {
          const is404 = isAxiosError(err) && err.response?.status === 404;
          updates.set(section.id, false);
          if (is404) cacheRef.current.set(makeKey(section), false);
        }
      });

      const queue = [...tasks];
      const worker = async () => { while (queue.length > 0) await queue.shift()!(); };
      await Promise.all(Array.from({ length: Math.min(5, tasks.length) }, worker));

      if (!cancelled) {
        setSectionHitObjectMap((prev) => {
          const next = new Map(prev);
          for (const [id, val] of updates) next.set(id, val);
          return next;
        });
      }
    }

    scanHitObjects();
    return () => { cancelled = true; };
  }, [decryptedSections, selectedDifficultyId, unlocked, mapsetId, getKey]);

  return sectionHitObjectMap;
}
