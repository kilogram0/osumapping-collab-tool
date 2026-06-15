import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import TopBar from './TopBar';

vi.mock('./LanguageSwitcher', () => ({
  default: () => <div data-testid="language-switcher" />,
}));

vi.mock('./BackgroundToggle', () => ({
  default: () => <div data-testid="background-toggle" />,
}));

describe('TopBar', () => {
  it('renders the language switcher', () => {
    render(<TopBar />);
    expect(screen.getByTestId('language-switcher')).toBeInTheDocument();
  });

  it('renders the background toggle', () => {
    render(<TopBar />);
    expect(screen.getByTestId('background-toggle')).toBeInTheDocument();
  });

  it('renders left content when provided', () => {
    render(<TopBar left={<button>Back</button>} />);
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
  });

  it('renders no left content when left prop is omitted', () => {
    render(<TopBar />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
