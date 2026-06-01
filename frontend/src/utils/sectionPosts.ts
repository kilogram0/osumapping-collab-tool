import type { DecryptedPost } from '../types';

export interface SectionRange {
  startTimeMs: number;
  endTimeMs: number;
  /** When true the upper bound is inclusive so a post landing exactly on the
   *  song's final ms isn't excluded from every section. */
  isLastSection?: boolean;
}

/**
 * Filter a flat post list down to the threads anchored in a section's time
 * range. A top-level post belongs when its extracted timestamp falls in
 * [start, end) (inclusive end for the last section). A reply belongs when its
 * root ancestor is a post in this section, regardless of the reply's own
 * timestamp — replies reference context, not necessarily the same position.
 */
export function filterPostsBySection(
  posts: DecryptedPost[],
  { startTimeMs, endTimeMs, isLastSection = false }: SectionRange,
): DecryptedPost[] {
  const postById = new Map(posts.map((p) => [p.id, p]));

  // Walk the parent chain to find the root (top-level) post id.
  // Visited set guards against cycles in malformed data.
  function findRootId(postId: string): string {
    let current = postId;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(current)) return current;
      visited.add(current);
      const post = postById.get(current);
      if (!post || post.parent_id === null) return current;
      current = post.parent_id;
    }
  }

  const inSectionByTimestamp = (p: DecryptedPost) => {
    if (p.extractedMs === null) return false;
    if (p.extractedMs < startTimeMs) return false;
    // Half-open [start, end) — final section uses inclusive upper bound.
    return isLastSection ? p.extractedMs <= endTimeMs : p.extractedMs < endTimeMs;
  };

  // Top-level posts whose timestamp falls in this section anchor the threads.
  const sectionRootIds = new Set(
    posts.filter((p) => p.parent_id === null && inSectionByTimestamp(p)).map((p) => p.id),
  );

  return posts.filter((p) =>
    p.parent_id === null ? sectionRootIds.has(p.id) : sectionRootIds.has(findRootId(p.id)),
  );
}

/**
 * Return the section in a pre-sorted list that contains `ms`, using the same
 * [start, end) / [start, end] boundary convention as filterPostsBySection.
 * Returns undefined when ms falls in a gap, before the first section, or after
 * the last — callers should treat that as "no owning section".
 */
export function findSectionForMs<T extends { startTimeMs: number; endTimeMs: number }>(
  sortedSections: T[],
  ms: number,
): T | undefined {
  return sortedSections.find((s, i) => {
    const isLast = i === sortedSections.length - 1;
    return ms >= s.startTimeMs && (isLast ? ms <= s.endTimeMs : ms < s.endTimeMs);
  });
}
