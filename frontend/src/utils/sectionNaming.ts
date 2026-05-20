/**
 * Section-name convention shared by all bookmark-import code paths
 * (ImportBookmarksButton, CreateDifficultyModal, CreateMapsetModal).
 *
 * Short labels (S1, S2, …) so that many sections divide the timeline without
 * cutting off the name in the UI. Decoupled from `sort_order` so reordering
 * after import doesn't make the name and ordinal disagree.
 */
export function sectionNameForIndex(zeroBasedIndex: number): string {
  return `S${zeroBasedIndex + 1}`;
}
