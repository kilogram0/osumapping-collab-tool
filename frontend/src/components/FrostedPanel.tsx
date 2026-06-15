import type { ReactNode } from 'react';
import { useBackgroundEnabled } from '../hooks/useBackgroundEnabled';

interface FrostedPanelProps {
  children: ReactNode;
  /** Classes for the wrapper (e.g. the column width/centering: `max-w-4xl mx-auto`). */
  className?: string;
}

/**
 * Wraps a page's main content column and lays a frosted-glass layer behind it,
 * softening the TrianglesBackground canvas only where the content sits while
 * leaving the side margins crisp. Used on the Dashboard and Mapset views, where
 * the moving triangles would otherwise compete with dense UI; the login page
 * omits it and keeps the triangles sharp.
 *
 * The frosted layer is absolutely positioned with a negative z-index so it
 * paints *above* the fixed canvas (which sits at `-z-10`) but *below* this
 * wrapper's in-flow content — so `backdrop-blur` blurs the triangles and the
 * content stays crisp on top. The `relative` wrapper is only a positioning
 * context and deliberately sets no z-index: that keeps it from forming a
 * stacking context, so the `-z-[5]` layer participates in the *root* stacking
 * context and lands directly between the `-z-10` canvas and the page content.
 * (A z-index on the wrapper wouldn't hide the layer — it would scope the layer
 * to the wrapper's own stacking context instead, which we don't need.)
 */
export default function FrostedPanel({ children, className = '' }: FrostedPanelProps) {
  const enabled = useBackgroundEnabled();
  return (
    <div className={`relative ${className}`}>
      {enabled && (
        <div
          aria-hidden="true"
          data-testid="frosted-panel-backdrop"
          className="pointer-events-none absolute -inset-4 -z-[5] rounded-2xl bg-surface/40 backdrop-blur-xl"
        />
      )}
      {children}
    </div>
  );
}
