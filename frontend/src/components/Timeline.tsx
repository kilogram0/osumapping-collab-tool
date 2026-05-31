import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DecryptedSection } from './SectionList';
import type { DecryptedPost } from '../types';
import type { PostTag } from '../api/endpoints';
import { formatTimestamp } from '../utils/extractTimestamp';

function PlusIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}

// Higher-priority tags get higher z-index so they dominate visually when markers overlap.
// resolve/reopen are excluded: replies never appear in the timeline.
const TAG_MARKER: Partial<Record<PostTag, { color: string; z: number }>> = {
  problem:    { color: '#ef4444', z: 40 },
  suggestion: { color: '#eab308', z: 30 },
  praise:     { color: '#3b82f6', z: 20 },
  general:    { color: '#a855f7', z: 10 },
};

const RESOLVED_MARKER = { color: '#22c55e', z: 5 };

interface TimelineProps {
  sections: DecryptedSection[];
  posts: DecryptedPost[];
  songLengthMs: number;
  selectedSectionId: string | null;
  onSelectSection: (sectionId: string) => void;
  onJumpToPost?: (postId: string) => void;
  membersById?: Map<string, { username: string }>;
  sectionHitObjectMap?: Map<string, boolean>;
  /** IDs of root posts whose last status reply has tag 'resolve'. */
  resolvedPostIds?: Set<string>;
  /**
   * Owner-only: opens the create-section flow. When provided and there is
   * still song time after the last section, an inline "+" button fills the
   * remaining width of the bar (with a clickable minimum size).
   */
  onAddSection?: () => void;
}

// OKLCH hue sweep: 20° (orange-red) → 310° (violet), 290° total range.
// OKLCH is perceptually uniform — equal hue steps look like equal color differences,
// unlike HSL where the green-blue band appears compressed to the human eye.
function memberHue(idx: number, total: number): number {
  return total <= 1 ? 20 : 20 + (idx / (total - 1)) * 290;
}

function sectionBg(hue: number | null, pending: boolean): string {
  // hue === null → unassigned; chroma 0 gives neutral grey in any hue
  const c = hue !== null ? `0.15 ${hue}` : '0 0';
  return pending ? `oklch(42% ${c} / 0.4)` : `oklch(${hue !== null ? 62 : 42}% ${c})`;
}

export default function Timeline({
  sections,
  posts,
  songLengthMs,
  selectedSectionId,
  onSelectSection,
  onJumpToPost,
  membersById,
  sectionHitObjectMap,
  resolvedPostIds,
  onAddSection,
}: TimelineProps) {
  const { t } = useTranslation();
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    content: React.ReactNode;
  } | null>(null);

  const sortedSections = useMemo(() => {
    return [...sections].sort((a, b) => a.startTimeMs - b.startTimeMs || a.sortOrder - b.sortOrder);
  }, [sections]);

  // Map each assigned user ID to a hue (0–300°), sorted by username.
  const memberHueMap = useMemo(() => {
    const uniqueIds = [...new Set(sections.map((s) => s.assignedTo).filter((id): id is string => id !== null))];
    uniqueIds.sort((a, b) => {
      const nameA = membersById?.get(a)?.username ?? a;
      const nameB = membersById?.get(b)?.username ?? b;
      return nameA.localeCompare(nameB);
    });
    const map = new Map<string, number>();
    uniqueIds.forEach((id, idx) => {
      map.set(id, memberHue(idx, uniqueIds.length));
    });
    return map;
  }, [sections, membersById]);

  const markerPosts = useMemo(() => {
    // Only root posts get a marker — one dot per discussion thread, not per reply.
    return posts.filter(
      (p) =>
        p.parent_id === null &&
        p.extractedMs !== null &&
        p.extractedMs >= 0 &&
        p.extractedMs <= songLengthMs,
    );
  }, [posts, songLengthMs]);

  if (songLengthMs <= 0) {
    return (
      <div className="w-full h-24 bg-gray-800 border border-gray-700 rounded-lg flex items-center justify-center">
        <p className="text-sm text-gray-500">{t('timeline.unavailable')}</p>
      </div>
    );
  }

  // The add-section affordance occupies whatever song time is left after the
  // furthest section end. With no sections it spans the whole bar; once
  // sections cover the song it disappears entirely.
  const lastEndMs = sortedSections.reduce((max, s) => Math.max(max, s.endTimeMs), 0);
  const coveredFraction = Math.min(1, lastEndMs / songLengthMs);
  const songFilled = lastEndMs >= songLengthMs;
  const showAddSection = !!onAddSection && !songFilled;
  // Reserve a fixed strip for the "+" so it always stays comfortably clickable
  // and never overlaps the last section. Sections are laid out inside a content
  // area shrunk by this reserve (only while the "+" is shown); the "+" then fills
  // everything from the last section's end through the reserved strip. The reserve
  // matches the width of the icon-only upload button (px-4 + 16px icon = 3rem).
  const ADD_RESERVE = '3rem';
  const contentWidth = showAddSection ? `calc(100% - ${ADD_RESERVE})` : '100%';

  function handleMarkerClick(postId: string) {
    onJumpToPost?.(postId);
  }

  return (
    <div className="w-full">
      {/* Timeline bar. `isolate` confines the marker z-indices (up to 40) to
          this bar's own stacking context, so they can't paint over sibling
          overlays like the difficulty dropdown (z-30) that open above it. */}
      <div
        className="relative isolate w-full h-24 bg-gray-800 border border-gray-700 rounded-lg overflow-hidden"
        data-testid="timeline-bar"
      >
        {/* Content area: sections and markers map over the full song into this
            box, which is narrowed by ADD_RESERVE while the "+" is shown so the
            "+" strip can never collide with the last section. */}
        <div className="absolute inset-y-0 left-0" style={{ width: contentWidth }}>
        {sortedSections.map((section, index) => {
          const duration = section.endTimeMs - section.startTimeMs;
          const widthPercent = (duration / songLengthMs) * 100;
          const leftPercent = (section.startTimeMs / songLengthMs) * 100;
          const isSelected = selectedSectionId === section.id;
          const isLast = index === sortedSections.length - 1;

          // undefined = scan not yet complete; treat as "has content" to avoid flash.
          const pending = sectionHitObjectMap?.get(section.id) === false;
          const hue = section.assignedTo != null ? (memberHueMap.get(section.assignedTo) ?? null) : null;

          return (
            <button
              key={section.id}
              type="button"
              data-testid={`timeline-section-${section.id}`}
              className={`absolute top-0 bottom-0 transition-all hover:brightness-110
                ${isLast ? '' : 'border-r-2 border-black/30'}
                ${isSelected ? 'ring ring-inset ring-white z-10' : ''}
                flex items-center justify-center text-white text-xs font-medium px-1
                overflow-hidden whitespace-nowrap text-ellipsis`}
              style={{
                left: `${leftPercent}%`,
                width: `${widthPercent}%`,
                backgroundColor: sectionBg(hue, pending),
              }}
              onClick={() => onSelectSection(section.id)}
              onMouseEnter={(e) => {
                setTooltip({
                  x: e.clientX,
                  y: e.clientY,
                  content: (
                    <div>
                      <p className="font-semibold">{section.name}</p>
                      <p className="text-xs text-gray-300">
                        {formatTimestamp(section.startTimeMs)} – {formatTimestamp(section.endTimeMs)}
                      </p>
                    </div>
                  ),
                });
              }}
              onMouseMove={(e) => {
                setTooltip((prev) =>
                  prev
                    ? { ...prev, x: e.clientX, y: e.clientY }
                    : null,
                );
              }}
              onMouseLeave={() => {
                setTooltip(null);
              }}
            >
              <span className="truncate px-1">{section.name}</span>
            </button>
          );
        })}

        {/* Post markers — root posts only; resolved posts shown in green at lowest z */}
        {markerPosts.map((post) => {
          const leftPercent = ((post.extractedMs ?? 0) / songLengthMs) * 100;
          const resolved = resolvedPostIds?.has(post.id) ?? false;
          const marker = resolved ? RESOLVED_MARKER : (TAG_MARKER[post.tag] ?? { color: '#6b7280', z: 10 });
          return (
            <button
              key={post.id}
              type="button"
              data-testid={`timeline-marker-${post.id}`}
              className="absolute top-1 w-4 h-4 rounded-full border-2 border-gray-900 shadow hover:scale-125 transition-transform"
              style={{
                left: `calc(${leftPercent}% - 8px)`,
                backgroundColor: marker.color,
                zIndex: marker.z,
              }}
              title={t('timeline.postAt', { time: formatTimestamp(post.extractedMs ?? 0) })}
              onClick={(e) => {
                e.stopPropagation();
                handleMarkerClick(post.id);
              }}
              onMouseEnter={(e) => {
                setTooltip({
                  x: e.clientX,
                  y: e.clientY,
                  content: (
                    <div>
                      <p className="font-semibold">{t('timeline.postLabel')}</p>
                      <p className="text-xs text-gray-300">
                        {formatTimestamp(post.extractedMs ?? 0)}
                      </p>
                    </div>
                  ),
                });
              }}
              onMouseMove={(e) => {
                setTooltip((prev) =>
                  prev ? { ...prev, x: e.clientX, y: e.clientY } : null,
                );
              }}
              onMouseLeave={() => setTooltip(null)}
            />
          );
        })}
        </div>

        {/* Add-section affordance: starts where the last section ends (in the
            shrunk content space) and fills through to the right edge — so it
            covers the empty remaining song time plus the reserved strip, never
            overlapping a section. */}
        {showAddSection && (
          <button
            type="button"
            data-testid="timeline-add-section"
            onClick={onAddSection}
            aria-label={t('mapsetPage.addSection')}
            title={t('mapsetPage.addSection')}
            className={`absolute top-0 bottom-0 flex items-center justify-center text-gray-400 hover:bg-gray-700/50 hover:text-white transition-colors ${
              sortedSections.length > 0 ? 'border-l-2 border-dashed border-gray-600' : ''
            }`}
            style={{ left: `calc(${coveredFraction} * (100% - ${ADD_RESERVE}))`, right: 0 }}
          >
            <PlusIcon />
          </button>
        )}

      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 px-3 py-2 bg-gray-900 border border-gray-700 rounded shadow-lg text-sm text-white pointer-events-none"
          style={{
            left: tooltip.x + 12,
            top: tooltip.y - 12,
          }}
        >
          {tooltip.content}
        </div>
      )}
    </div>
  );
}
