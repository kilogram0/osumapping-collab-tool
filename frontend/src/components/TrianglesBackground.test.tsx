import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TrianglesBackground from './TrianglesBackground';

// jsdom implements neither a 2d canvas context nor matchMedia, so we stub both
// and let the real animation setup run against the stubs.

function fakeContext() {
  return {
    setTransform: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillStyle: '',
  };
}

function mockMatchMedia(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('TrianglesBackground', () => {
  let ctx: ReturnType<typeof fakeContext>;
  let rafSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    ctx = fakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
    // Return a handle but never invoke the callback, so the loop schedules
    // exactly once and the test doesn't spin.
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders a decorative, non-interactive canvas behind content', () => {
    mockMatchMedia(false);
    render(<TrianglesBackground />);
    const canvas = screen.getByTestId('triangles-background');
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    expect(canvas).toHaveClass('-z-10', 'pointer-events-none');
  });

  it('drives an animation loop when motion is allowed', () => {
    mockMatchMedia(false);
    render(<TrianglesBackground />);
    expect(rafSpy).toHaveBeenCalled();
  });

  it('paints a single static frame and skips the loop under prefers-reduced-motion', () => {
    mockMatchMedia(true);
    render(<TrianglesBackground />);
    expect(rafSpy).not.toHaveBeenCalled();
    // Static frame still paints the gradient base.
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it('keeps the gradient but draws no triangles or animation when disabled', () => {
    localStorage.setItem('triangles-bg-enabled', 'false');
    mockMatchMedia(false);
    render(<TrianglesBackground />);
    // Canvas still mounts and the gradient base is painted...
    expect(screen.getByTestId('triangles-background')).toBeInTheDocument();
    expect(ctx.fillRect).toHaveBeenCalled();
    // ...but no triangle is filled and no animation loop is scheduled.
    expect(ctx.fill).not.toHaveBeenCalled();
    expect(rafSpy).not.toHaveBeenCalled();
  });
});
