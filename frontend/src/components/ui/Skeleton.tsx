import type { HTMLAttributes } from 'react';

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** Visual shape of the skeleton. */
  variant?: 'text' | 'rect' | 'circle';
  /** Width class or inline width. Defaults to full width for text/rect. */
  width?: string;
  /** Height class or inline height. */
  height?: string;
}

/**
 * Pulsing placeholder used while async content is loading. Prefer this over
 * bare text so layouts stay stable and the loading state feels intentional.
 */
export default function Skeleton({
  variant = 'text',
  width,
  height,
  className = '',
  style,
  ...rest
}: SkeletonProps) {
  const base = 'animate-pulse bg-surface-panel';
  const shape =
    variant === 'circle'
      ? 'rounded-full'
      : variant === 'text'
        ? 'rounded h-4'
        : 'rounded-lg';

  return (
    <div
      className={`${base} ${shape} ${className}`}
      style={{
        width: width ?? (variant === 'text' ? '100%' : undefined),
        height: height ?? (variant === 'rect' ? '100%' : undefined),
        ...style,
      }}
      {...rest}
    />
  );
}
