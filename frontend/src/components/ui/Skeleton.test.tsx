import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Skeleton from './Skeleton';

describe('Skeleton', () => {
  it('renders a text skeleton by default', () => {
    render(<Skeleton data-testid="skeleton" />);
    const el = screen.getByTestId('skeleton');
    expect(el).toHaveClass('animate-pulse');
    expect(el).toHaveClass('rounded');
  });

  it('renders a circle skeleton', () => {
    render(<Skeleton variant="circle" data-testid="skeleton" width="2rem" height="2rem" />);
    const el = screen.getByTestId('skeleton');
    expect(el).toHaveClass('rounded-full');
  });

  it('renders a rectangular skeleton', () => {
    render(<Skeleton variant="rect" data-testid="skeleton" height="10rem" />);
    const el = screen.getByTestId('skeleton');
    expect(el).toHaveClass('rounded-lg');
  });
});
