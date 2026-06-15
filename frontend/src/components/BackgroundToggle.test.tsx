import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import BackgroundToggle from './BackgroundToggle';

const NAME = 'Toggle Animated Background';

describe('BackgroundToggle', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('shows the label text and starts pressed (background on) by default', () => {
    render(<BackgroundToggle />);
    const btn = screen.getByRole('button', { name: NAME });
    expect(btn).toHaveTextContent(NAME);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('toggles the preference and persists it on click', () => {
    render(<BackgroundToggle />);
    const btn = screen.getByRole('button', { name: NAME });

    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem('triangles-bg-enabled')).toBe('false');

    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('triangles-bg-enabled')).toBe('true');
  });
});
