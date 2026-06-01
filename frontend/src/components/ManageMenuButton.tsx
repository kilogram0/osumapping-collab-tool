import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ManageMenuButtonProps {
  /** Open the base version history modal. */
  onOpenBaseHistory: () => void;
  /** Base history is difficulty-scoped; disable it when nothing is selected. */
  baseHistoryDisabled?: boolean;
  /** Whether the members option is shown (member-only, hidden for ghosts). */
  showMembers: boolean;
  /** Label for the members option ("Manage Members" vs "View Members"). */
  membersLabel: string;
  /** Open the manage/view members modal. */
  onOpenMembers: () => void;
}

function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v1.7M8 12.8v1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M1.5 8h1.7M12.8 8h1.7M3.4 12.6l1.2-1.2M11.4 4.6l1.2-1.2" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export default function ManageMenuButton({
  onOpenBaseHistory,
  baseHistoryDisabled = false,
  showMembers,
  membersLabel,
  onOpenMembers,
}: ManageMenuButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback((returnFocus: boolean) => {
    setOpen(false);
    // On keyboard-driven dismissal (Escape, or activating an item) send focus
    // back to the trigger so it doesn't get stranded on the now-removed menu.
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeMenu(true);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, closeMenu]);

  // Move focus into the menu when it opens (APG menu-button pattern). Disabled
  // items stay focusable so AT users can still discover them and their reason.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);

  // Arrow-key roving focus across all items (including disabled ones, per APG),
  // wrapping at the ends. Activation is still blocked for disabled items below.
  function handleMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(current + 1 + items.length) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(current - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1].focus();
    }
  }

  const menuId = 'manage-menu';

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
      >
        <GearIcon />
        {t('mapsetPage.manage')}
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={t('mapsetPage.manageMenuLabel')}
          onKeyDown={handleMenuKeyDown}
          className="absolute right-0 z-30 mt-1 min-w-full whitespace-nowrap rounded-lg border border-gray-700 bg-gray-800 shadow-xl py-1"
        >
          <button
            type="button"
            role="menuitem"
            // aria-disabled (not the native `disabled` attribute) keeps the item
            // focusable and announced, so its title explanation reaches AT users;
            // activation is guarded in the handler instead.
            aria-disabled={baseHistoryDisabled || undefined}
            onClick={() => {
              if (baseHistoryDisabled) return;
              closeMenu(true);
              onOpenBaseHistory();
            }}
            title={baseHistoryDisabled ? t('mapsetPage.baseHistoryDisabled') : undefined}
            className="block w-full px-4 py-2 text-left text-sm text-white hover:bg-gray-700 aria-disabled:text-gray-500 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent transition-colors"
          >
            {t('mapsetPage.baseHistory')}
          </button>
          {showMembers && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu(true);
                onOpenMembers();
              }}
              className="block w-full px-4 py-2 text-left text-sm text-white hover:bg-gray-700 transition-colors"
            >
              {membersLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
