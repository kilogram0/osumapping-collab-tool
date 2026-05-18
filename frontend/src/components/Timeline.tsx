import { useState, useMemo } from 'react';
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
}

// Static class strings so Tailwind's JIT can detect them at build time.
// Each entry pairs the base bg with its hover: variant — never reuse the
// lighter shade as the base, since both classes are emitted together and
// the lighter one would win under Tailwind source ordering.
const SECTION_COLORS: { base: string; hover: string }[] = [
  { base: 'bg-blue-600', hover: 'hover:bg-blue-500' },
  { base: 'bg-emerald-600', hover: 'hover:bg-emerald-500' },
  { base: 'bg-amber-600', hover: 'hover:bg-amber-500' },
  { base: 'bg-rose-600', hover: 'hover:bg-rose-500' },
  { base: 'bg-violet-600', hover: 'hover:bg-violet-500' },
  { base: 'bg-cyan-600', hover: 'hover:bg-cyan-500' },
  { base: 'bg-orange-600', hover: 'hover:bg-orange-500' },
  { base: 'bg-pink-600', hover: 'hover:bg-pink-500' },
];

function getSectionColors(index: number): { base: string; hover: string } {
  return SECTION_COLORS[index % SECTION_COLORS.length];
}

export default function Timeline({
  sections,
  posts,
  songLengthMs,
  selectedSectionId,
  onSelectSection,
  onJumpToPost,
}: TimelineProps) {
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    content: React.ReactNode;
  } | null>(null);

  const sortedSections = useMemo(() => {
    return [...sections].sort((a, b) => a.startTimeMs - b.startTimeMs || a.sortOrder - b.sortOrder);
  }, [sections]);

  const markerPosts = useMemo(() => {
    return posts.filter(
      (p) => p.extractedMs !== null && p.extractedMs >= 0 && p.extractedMs <= songLengthMs,
    );
  }, [posts, songLengthMs]);

  if (songLengthMs <= 0) {
    return (
      <div className="w-full h-16 bg-gray-800 border border-gray-700 rounded-lg flex items-center justify-center">
        <p className="text-sm text-gray-500">No timeline available</p>
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
          const { base: colorClass, hover: hoverClass } = getSectionColors(index);

          return (
            <button
              key={section.id}
              type="button"
              data-testid={`timeline-section-${section.id}`}
              className={`absolute top-0 bottom-0 ${colorClass} ${hoverClass} transition-colors
                ${isSelected ? 'ring-2 ring-white z-10' : ''}
                flex items-center justify-center text-white text-xs font-medium px-1
                overflow-hidden whitespace-nowrap text-ellipsis`}
              style={{
                left: `${leftPercent}%`,
                width: `${widthPercent}%`,
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
              title={`Post at ${formatTimestamp(post.extractedMs ?? 0)}`}
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
                      <p className="font-semibold">Post</p>
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
