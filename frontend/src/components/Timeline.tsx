import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DecryptedSection } from './SectionList';
import type { DecryptedPost } from '../types';
import { formatTimestamp } from '../utils/extractTimestamp';

interface TimelineProps {
  sections: DecryptedSection[];
  posts: DecryptedPost[];
  songLengthMs: number;
  selectedSectionId: string | null;
  onSelectSection: (sectionId: string) => void;
  onJumpToPost?: (postId: string) => void;
  membersById?: Map<string, { username: string }>;
  sectionHitObjectMap?: Map<string, boolean>;
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
    return posts.filter(
      (p) => p.extractedMs !== null && p.extractedMs >= 0 && p.extractedMs <= songLengthMs,
    );
  }, [posts, songLengthMs]);

  if (songLengthMs <= 0) {
    return (
      <div className="w-full h-16 bg-gray-800 border border-gray-700 rounded-lg flex items-center justify-center">
        <p className="text-sm text-gray-500">{t('timeline.unavailable')}</p>
      </div>
    );
  }

  function handleMarkerClick(postId: string) {
    onJumpToPost?.(postId);
  }

  return (
    <div className="w-full">
      {/* Timeline bar */}
      <div
        className="relative w-full h-16 bg-gray-800 border border-gray-700 rounded-lg overflow-hidden"
        data-testid="timeline-bar"
      >
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

        {/* Post markers */}
        {markerPosts.map((post) => {
          const leftPercent = ((post.extractedMs ?? 0) / songLengthMs) * 100;
          return (
            <button
              key={post.id}
              type="button"
              data-testid={`timeline-marker-${post.id}`}
              className="absolute top-1 w-3 h-3 bg-white rounded-full border-2 border-gray-900 shadow hover:scale-125 transition-transform z-20"
              style={{ left: `calc(${leftPercent}% - 6px)` }}
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
