import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import Button from './Button';

describe('Button', () => {
  it('renders children and responds to clicks', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click me</Button>);
    const button = screen.getByRole('button', { name: /click me/i });
    expect(button).toBeInTheDocument();
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalled();
  });

  it('is disabled when disabled prop is true', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('shows a spinner and ignores clicks while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>,
    );
    const button = screen.getByRole('button', { name: /saving/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('supports danger variant', () => {
    render(<Button variant="danger">Delete</Button>);
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('supports ghost variant', () => {
    render(<Button variant="ghost">Cancel</Button>);
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });
});
