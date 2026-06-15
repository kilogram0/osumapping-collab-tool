import type { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  /** Render as a plain panel without a border for nested contexts. */
  flat?: boolean;
}

/**
 * Basic container primitive. Use for panels, list items, and other raised
 * surfaces so elevation/border-radius stays consistent.
 */
export default function Card({ children, className = '', flat = false }: CardProps) {
  return (
    <div
      className={`${flat ? 'bg-surface-panel/80' : 'bg-surface-raised/80 border border-surface-border'} backdrop-blur-md rounded-lg ${className}`}
    >
      {children}
    </div>
  );
}
