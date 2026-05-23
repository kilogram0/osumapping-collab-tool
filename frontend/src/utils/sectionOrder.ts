/**
 * Canonical section sort order: ascending sortOrder, lexicographic id as a
 * stable tiebreaker. All flows that derive section position (edit, delete,
 * merged-download clipping) must use this function so tiebreaker semantics
 * can't drift between them.
 */
export function sortSections<T extends { sortOrder: number; id: string }>(
  sections: T[],
): T[] {
  return [...sections].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
  );
}

/**
 * Return the section that follows `id` in sortOrder (lexicographic id as a
 * stable tiebreaker), or `null` if `id` is the last section. Used by edit
 * and delete flows to find the destination for migrated hit objects.
 */
export function findNextSection<T extends { sortOrder: number; id: string }>(
  sections: T[],
  id: string,
): T | null {
  const sorted = sortSections(sections);
  const idx = sorted.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  return sorted[idx + 1] ?? null;
}
