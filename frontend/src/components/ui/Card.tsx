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
      className={`${flat ? 'bg-surface-panel' : 'bg-surface-raised border border-surface-border'} rounded-lg ${className}`}
    >
      {children}
    </div>
  );
}
