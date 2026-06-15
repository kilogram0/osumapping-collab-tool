import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  /** Controls visibility. The component should be conditionally rendered by the
   *  caller; this prop is mostly used to drive entrance animations/focus. */
  open: boolean;
  /** Id of the element that labels the dialog (usually the title). */
  ariaLabelledBy: string;
  onClose: () => void;
  children: ReactNode;
  /** Maximum width class for the panel. */
  maxWidth?: 'sm' | 'md' | 'lg';
  /** Close when the user clicks the backdrop. Default true. */
  closeOnBackdrop?: boolean;
  /** Close when the user presses Escape. Default true. */
  closeOnEscape?: boolean;
}

const maxWidthClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
};

/**
 * Accessible modal dialog primitive.
 *
 * - Traps focus inside the panel while open.
 * - Closes on backdrop click and Escape by default.
 * - Restores focus to the previously focused element on close.
 */
export default function Modal({
  open,
  ariaLabelledBy,
  onClose,
  children,
  maxWidth = 'md',
  closeOnBackdrop = true,
  closeOnEscape = true,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement as HTMLElement;
    // Move focus into the panel after it mounts.
    const panel = panelRef.current;
    if (panel) {
      const focusable = panel.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (focusable ?? panel).focus();
    }

    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !closeOnEscape) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, closeOnEscape, onClose]);

  function handleBackdropClick(e: React.MouseEvent) {
    if (closeOnBackdrop && e.target === e.currentTarget) {
      onClose();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Tab' || !panelRef.current) return;

    const focusable = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex >= 0);

    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={ariaLabelledBy}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`bg-surface-raised border border-surface-border rounded-lg shadow-xl w-full ${maxWidthClasses[maxWidth]} max-h-[90vh] overflow-y-auto`}
      >
        {children}
      </div>
    </div>
  );
}
