import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../contexts/ToastContext';
import {
  buildAssignmentText,
  buildRawAssignmentText,
  toAssignmentInputs,
  type AssignableSection,
} from '../utils/sectionAssignments';

interface CopyAssignmentsButtonProps {
  sections: AssignableSection[];
  membersById: Map<string, { username: string }>;
  disabled?: boolean;
}

function CopyIcon() {
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
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
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

export default function CopyAssignmentsButton({
  sections,
  membersById,
  disabled,
}: CopyAssignmentsButtonProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const inputs = useMemo(
    () =>
      toAssignmentInputs(sections, {
        resolveUsername: (id) => membersById.get(id)?.username,
        unassignedLabel: t('mapsetPage.unassigned'),
        unknownUserLabel: t('mapsetPage.unknownUser'),
      }),
    [sections, membersById, t],
  );

  const submissionText = useMemo(() => buildAssignmentText(inputs), [inputs]);
  const rawText = useMemo(() => buildRawAssignmentText(inputs), [inputs]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('mapsetPage.toastAssignmentsCopied'), 'success');
    } catch {
      showToast(t('mapsetPage.toastFailedCopyAssignments'), 'error');
    }
  }

  const menuId = 'copy-assignments-menu';
  const hasSections = sections.length > 0;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || !hasSections}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t('mapsetPage.copyAssignments')}
        title={t('mapsetPage.copyAssignments')}
        className="inline-flex items-center gap-1.5 px-4 py-3.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:hover:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
      >
        <CopyIcon />
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t('mapsetPage.copyAssignmentsMenuLabel')}
          className="absolute right-0 z-30 mt-1 min-w-full whitespace-nowrap rounded-lg border border-gray-700 bg-gray-800 shadow-xl py-1"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void copy(submissionText);
            }}
            className="block w-full px-4 py-2 text-left text-sm text-white hover:bg-gray-700 transition-colors"
          >
            {t('mapsetPage.copyAssignmentsForSubmission')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void copy(rawText);
            }}
            className="block w-full px-4 py-2 text-left text-sm text-white hover:bg-gray-700 transition-colors"
          >
            {t('mapsetPage.copyAssignmentsRaw')}
          </button>
        </div>
      )}
    </div>
  );
}
