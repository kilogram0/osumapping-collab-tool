import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import FrostedPanel from './FrostedPanel';

describe('FrostedPanel', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('renders its children', () => {
    render(
      <FrostedPanel>
        <p>content</p>
      </FrostedPanel>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('merges the wrapper className onto a relative-positioned wrapper', () => {
    render(
      <FrostedPanel className="max-w-4xl mx-auto">
        <p>content</p>
      </FrostedPanel>,
    );
    const wrapper = screen.getByText('content').parentElement!;
    expect(wrapper).toHaveClass('relative', 'max-w-4xl', 'mx-auto');
  });

  it('lays a decorative, non-interactive frosted layer behind the content', () => {
    render(
      <FrostedPanel>
        <p>content</p>
      </FrostedPanel>,
    );
    const backdrop = screen.getByTestId('frosted-panel-backdrop');
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
    // Behind content (negative z), blurs the canvas, never intercepts clicks.
    expect(backdrop).toHaveClass('absolute', '-z-[5]', 'backdrop-blur-xl', 'pointer-events-none');
  });

  it('omits the frosted layer when the background is disabled', () => {
    localStorage.setItem('triangles-bg-enabled', 'false');
    render(
      <FrostedPanel>
        <p>content</p>
      </FrostedPanel>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
    expect(screen.queryByTestId('frosted-panel-backdrop')).toBeNull();
  });
});
