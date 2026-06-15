import { useEffect, useRef } from 'react';
import { useBackgroundEnabled } from '../hooks/useBackgroundEnabled';

/**
 * Animated triangle field reminiscent of osu!lazer's menu background.
 *
 * Renders a single fixed, full-viewport <canvas> behind all app content
 * (z-index -10). Translucent pink/blue equilateral triangles drift slowly
 * upward over a dark gradient; nearer (larger) triangles move faster and sit
 * more opaque to fake depth/parallax. Content surfaces sit on top with a
 * `backdrop-blur` so the triangles soften wherever real content exists.
 *
 * Purely decorative (aria-hidden, pointer-events-none) and considerate:
 *  - can be turned off via the TopBar toggle (useBackgroundEnabled); when off,
 *    the gradient still paints but no triangles spawn and no loop runs;
 *  - respects `prefers-reduced-motion` by painting one static frame instead of
 *    running an animation loop;
 *  - pauses the loop while the tab is hidden (no wasted frames);
 *  - is devicePixelRatio-aware and re-fits on resize.
 */

interface Triangle {
  x: number; // center x, CSS px
  y: number; // center y, CSS px
  size: number; // side length, CSS px
  speed: number; // upward drift, CSS px / second
  drift: number; // horizontal drift, CSS px / second
  alpha: number;
  color: readonly [number, number, number];
}

// Darkened takes on osu! signature pink and the app's brand blue
// (tailwind brand.muted #60a5fa), toned down so the field reads as a subtle
// backdrop rather than competing with foreground content.
const PINK = [190, 76, 128] as const;
const BLUE = [72, 124, 188] as const;

// Density: triangles per CSS pixel of viewport area, capped so large displays
// don't pay for hundreds of fills.
const AREA_PER_TRIANGLE = 24_000;
const MAX_TRIANGLES = 70;

function makeTriangle(width: number, height: number, fromBottom: boolean): Triangle {
  // depth 0 (far) .. 1 (near): nearer triangles are bigger, faster, more opaque.
  const depth = Math.random();
  const size = 50 + depth * 160;
  const height3 = size * 0.866; // equilateral height ≈ size * √3/2
  return {
    x: Math.random() * width,
    y: fromBottom ? height + height3 : Math.random() * height,
    size,
    speed: 16 + depth * 44,
    drift: (Math.random() - 0.5) * 12,
    alpha: 0.01 + depth * 0.045,
    color: Math.random() < 0.5 ? PINK : BLUE,
  };
}

export default function TrianglesBackground() {
  const enabled = useBackgroundEnabled();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // unsupported / jsdom — leave the static body background.

    let width = 0;
    let height = 0;
    // Cached vertical gradient, rebuilt in fit() only when the size changes
    // rather than re-allocated on every animation frame.
    let gradient: CanvasGradient | null = null;
    const triangles: Triangle[] = [];

    function fit() {
      const c = canvas!;
      const context = ctx!;
      const dpr = window.devicePixelRatio || 1;
      // Fall back to the viewport if layout hasn't sized the canvas yet (a 0×0
      // canvas would paint nothing and look like a flat background).
      width = c.clientWidth || window.innerWidth;
      height = c.clientHeight || window.innerHeight;
      c.width = Math.max(1, Math.floor(width * dpr));
      c.height = Math.max(1, Math.floor(height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, '#141d2b');
      gradient.addColorStop(1, '#0b0f17');

      // Triangles only populate when enabled; disabled keeps the bare gradient.
      const target = enabled
        ? Math.min(MAX_TRIANGLES, Math.round((width * height) / AREA_PER_TRIANGLE))
        : 0;
      if (triangles.length > target) {
        triangles.length = target;
      } else {
        while (triangles.length < target) triangles.push(makeTriangle(width, height, false));
      }
    }

    function render() {
      const context = ctx!;
      if (gradient) context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);

      for (const tri of triangles) {
        const h = tri.size * 0.866;
        const [r, g, b] = tri.color;
        context.fillStyle = `rgba(${r}, ${g}, ${b}, ${tri.alpha})`;
        context.beginPath();
        context.moveTo(tri.x, tri.y - h / 2);
        context.lineTo(tri.x - tri.size / 2, tri.y + h / 2);
        context.lineTo(tri.x + tri.size / 2, tri.y + h / 2);
        context.closePath();
        context.fill();
      }
    }

    function step(dt: number) {
      for (let i = 0; i < triangles.length; i++) {
        const tri = triangles[i];
        tri.y -= tri.speed * dt;
        tri.x += tri.drift * dt;
        // Respawn once fully above the top edge.
        if (tri.y + tri.size * 0.866 < 0) {
          triangles[i] = makeTriangle(width, height, true);
        }
      }
      render();
    }

    fit();
    // Paint one frame immediately so there's never a blank gap between mount
    // and the first animation tick (and so the field is visible even if rAF is
    // throttled on the very first frame).
    render();

    const prefersReducedMotion =
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    // No animation loop when the triangles are toggled off (gradient only) or
    // when the user prefers reduced motion (one static triangle frame). Either
    // way, just keep the canvas sized and repaint once on resize.
    if (!enabled || prefersReducedMotion) {
      const onResizeStatic = () => {
        fit();
        render();
      };
      window.addEventListener('resize', onResizeStatic);
      return () => window.removeEventListener('resize', onResizeStatic);
    }

    let rafId = 0;
    let last = performance.now();

    function loop(now: number) {
      const dt = Math.min((now - last) / 1000, 0.05); // clamp tab-switch gaps
      last = now;
      step(dt);
      rafId = requestAnimationFrame(loop);
    }

    function onVisibility() {
      if (document.hidden) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      } else if (rafId === 0) {
        last = performance.now();
        rafId = requestAnimationFrame(loop);
      }
    }

    function onResize() {
      fit();
    }

    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    rafId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="triangles-background"
      className="fixed inset-0 -z-10 h-full w-full pointer-events-none"
    />
  );
}
