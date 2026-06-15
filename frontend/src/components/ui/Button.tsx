import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
  /** When true, the button shows a spinner and ignores pointer events. */
  loading?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-brand text-white hover:bg-brand-hover disabled:bg-brand/50 focus-visible:ring-brand-muted',
  secondary:
    'bg-surface-raised border border-surface-border text-white hover:bg-surface-panel focus-visible:ring-brand-muted',
  danger:
    'bg-danger text-white hover:bg-danger-hover disabled:bg-danger/50 focus-visible:ring-danger-muted',
  ghost:
    'bg-transparent text-muted-light hover:text-white hover:bg-white/5 focus-visible:ring-brand-muted',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-2.5 text-base',
};

/**
 * Shared button primitive. All interactive buttons should use this so focus
 * states, disabled styles, and colour intent stay consistent across the app.
 */
export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className = '',
  ...rest
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center rounded font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50 disabled:cursor-not-allowed';
  return (
    <button
      className={`${base} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && (
        <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
      )}
      {children}
    </button>
  );
}
