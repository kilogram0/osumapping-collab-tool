import type { ReactNode } from 'react';
import type { PostTag } from '../api/endpoints';

// Shared glyph: resolve tag badge and timeline resolved-marker use the same artwork.
const RESOLVED_PATHS: ReactNode = (
  <>
    <circle cx="8" cy="8" r="6.5"/>
    <path d="M5.5 8l2 2 3.5-4"/>
  </>
);

// Inline SVG paths for post tag icons. The SVG wrapper lives in TagIcon below;
// paths that deviate from the wrapper's strokeWidth="2" override it inline.
const PATHS: Record<PostTag, ReactNode> = {
  problem: (
    <>
      <circle cx="8" cy="8" r="6.5"/>
      <path d="M8 5v3.5"/>
      <path d="M8 11.5h.01" strokeWidth="2.5"/>
    </>
  ),
  suggestion: (
    <circle cx="8" cy="8" r="6.5"/>
  ),
  praise: (
    <path strokeWidth="1.75" d="M8 12.5C6 10.5 2 8 2 5.5C2 3.5 3.5 2 5.5 2C6.5 2 7.5 2.6 8 3.5C8.5 2.6 9.5 2 10.5 2C12.5 2 14 3.5 14 5.5C14 8 10 10.5 8 12.5Z"/>
  ),
  general: (
    <>
      <rect x="3" y="1.5" width="10" height="13" rx="1" strokeWidth="1.75"/>
      <path d="M5.5 5.5h5 M5.5 8.5h3" strokeWidth="1.75"/>
    </>
  ),
  resolve: RESOLVED_PATHS,
  reopen: (
    <>
      <path d="M3 8A5 5 0 1 0 8 3"/>
      <polyline points="6 1 8 3 6 5"/>
    </>
  ),
};

interface TagIconProps {
  tag: PostTag;
  /** When true, renders the resolved checkmark regardless of tag. */
  resolved?: boolean;
  size?: number;
}

export function TagIcon({ tag, resolved = false, size = 12 }: TagIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {resolved ? RESOLVED_PATHS : PATHS[tag]}
    </svg>
  );
}
