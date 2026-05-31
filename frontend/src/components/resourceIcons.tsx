import type { ReactNode } from 'react';

/**
 * Fixed pool of icon keys a resource may use. The chosen key is encrypted
 * client-side (like name/url) and stored opaquely; the server never sees it.
 * Legacy rows have no icon and fall back to {@link DEFAULT_RESOURCE_ICON}.
 *
 * Inline SVGs mirror the hand-rolled icon style in DifficultyDropdown
 * (16×16, stroke=currentColor, strokeWidth 1.5) — the project ships no icon
 * library.
 */
export const RESOURCE_ICON_KEYS = [
  'link',
  'download',
  'music',
  'image',
  'video',
  'archive',
  'document',
] as const;

export type ResourceIconKey = (typeof RESOURCE_ICON_KEYS)[number];

export const DEFAULT_RESOURCE_ICON: ResourceIconKey = 'link';

/** Human-readable label for a key (used for picker aria-labels). */
export const RESOURCE_ICON_LABELS: Record<ResourceIconKey, string> = {
  link: 'Link',
  download: 'Download',
  music: 'Audio',
  image: 'Image',
  video: 'Video',
  archive: 'Archive',
  document: 'Document',
};

function isResourceIconKey(value: string | null | undefined): value is ResourceIconKey {
  return value != null && (RESOURCE_ICON_KEYS as readonly string[]).includes(value);
}

/** Normalize an arbitrary (possibly null/unknown) key to a valid pool key. */
export function resolveResourceIcon(value: string | null | undefined): ResourceIconKey {
  return isResourceIconKey(value) ? value : DEFAULT_RESOURCE_ICON;
}

const PATHS: Record<ResourceIconKey, ReactNode> = {
  link: (
    <>
      <path d="M6 10l4-4" />
      <path d="M7.5 5.5l1-1a2 2 0 0 1 3 3l-1 1" />
      <path d="M8.5 10.5l-1 1a2 2 0 0 1-3-3l1-1" />
    </>
  ),
  download: (
    <>
      <path d="M8 2.5v7M5 7l3 3 3-3M3 12.5h10" />
    </>
  ),
  music: (
    <>
      <path d="M6 11.5V4l6-1.5V10" />
      <circle cx="4.5" cy="11.5" r="1.5" />
      <circle cx="10.5" cy="10" r="1.5" />
    </>
  ),
  image: (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
      <circle cx="5.5" cy="6.5" r="1" />
      <path d="M3 11l3-3 2 2 3-3 2.5 2.5" />
    </>
  ),
  video: (
    <>
      <rect x="2.5" y="4.5" width="8" height="7" rx="1" />
      <path d="M10.5 7l3-2v6l-3-2z" />
    </>
  ),
  archive: (
    <>
      <path d="M2.5 5.5h11v7h-11z" />
      <path d="M2.5 5.5l1.5-2h7l1.5 2" />
      <path d="M6.5 8.5h3" />
    </>
  ),
  document: (
    <>
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
      <path d="M6 8.5h4M6 10.5h4" />
    </>
  ),
};

interface ResourceIconProps {
  icon: string | null | undefined;
  className?: string;
}

/** Render the SVG glyph for a resource icon key, falling back to the default. */
export function ResourceIcon({ icon, className }: ResourceIconProps) {
  const key = resolveResourceIcon(icon);
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {PATHS[key]}
    </svg>
  );
}
