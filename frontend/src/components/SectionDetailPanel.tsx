import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemberWithUser } from '../api/endpoints';
import type { DecryptedSection } from './SectionList';
import OsuUploadButton from './OsuUploadButton';
import OsuVersionHistory from './OsuVersionHistory';
import { useEncryption } from '../contexts/EncryptionContext';
import { assembleSectionOsu } from '../utils/sectionDownload';
import { composeOsuFilename } from '../utils/osuFilename';
import { parseOsuFile, withMetadataVersion } from '../utils/osuParser';
import { logger } from '../utils/logger';
import { useSectionOsuVersions } from '../hooks/useDifficulty';

interface SectionDetailPanelProps {
  section: DecryptedSection;
  mapsetId: string;
  mapsetTitle: string;
  difficultyId: string;
  currentUserId: string;
  isOwner: boolean;
  role?: 'owner' | 'mapper' | 'modder' | null;
  canEditStructure: boolean;
  /** Lookup from user_id → member profile for resolving display names. */
  membersById?: Map<string, MemberWithUser>;
  onAssignSection?: (sectionId: string, userId: string | null) => void | Promise<void>;
  onEditSection?: (section: DecryptedSection) => void;
  onDeleteSection?: (section: DecryptedSection) => void | Promise<void>;
  /** The section that immediately follows this one in sort order, if any. */
  nextSection?: DecryptedSection | null;
  onMergeSection?: (section: DecryptedSection) => void | Promise<void>;
  onSplitSection?: (section: DecryptedSection) => void;
}

// Hand-rolled 16×16 glyphs matching the project's inline-SVG icon style
// (stroke=currentColor, strokeWidth 1.5). No icon library is shipped.
const ICON_BTN =
  'inline-flex items-center justify-center p-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors';

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5v7M5 7l3 3 3-3M3 12.5h10" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.5 2.5l2 2L6 12l-2.5.5.5-2.5 7.5-7.5z" />
      <path d="M10 4l2 2" />
    </svg>
  );
}

// Center divider with arrows pushing apart → split one section into two.
function SplitIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5v11" />
      <path d="M6 5L3.5 8 6 11" />
      <path d="M10 5l2.5 3-2.5 3" />
    </svg>
  );
}

// Center divider with arrows pulling inward → merge this section with the next.
function MergeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5v11" />
      <path d="M3.5 5L6 8l-2.5 3" />
      <path d="M12.5 5L10 8l2.5 3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.5 8h5l.5-8" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  const mm = minutes.toString().padStart(2, '0');
  const ss = seconds.toString().padStart(2, '0');
  const mmm = millis.toString().padStart(3, '0');
  if (hours > 0) {
    return `${hours}:${mm}:${ss}.${mmm}`;
  }
  return `${mm}:${ss}.${mmm}`;
}

export default function SectionDetailPanel({
  section,
  mapsetId,
  mapsetTitle,
  difficultyId,
  currentUserId,
  isOwner,
  role,
  canEditStructure,
  membersById,
  onAssignSection,
  onEditSection,
  onDeleteSection,
  nextSection,
  onMergeSection,
  onSplitSection,
}: SectionDetailPanelProps) {
  const { t } = useTranslation();
  const { isUnlocked, getKey } = useEncryption();
  const unlocked = isUnlocked(mapsetId);
  const [showHistory, setShowHistory] = useState(false);

  const { data: sectionVersions } = useSectionOsuVersions(difficultyId, section.id);
  const latestVersion = useMemo(() => {
    if (!sectionVersions || sectionVersions.length === 0) return null;
    return sectionVersions.reduce((best, v) => (v.version > best.version ? v : best));
  }, [sectionVersions]);
  const [showAssignSelect, setShowAssignSelect] = useState(false);

  // Edit + structural/destructive actions share the second row. Split/Merge/
  // Delete are owner-only; Edit follows canEditStructure (mappers get it too).
  const showEdit = canEditStructure && !!onEditSection;
  const showSplit = isOwner && !!onSplitSection;
  const showMerge = isOwner && !!nextSection && !!onMergeSection;
  const showDelete = isOwner && !!onDeleteSection;
  const hasStructureRow = showEdit || showSplit || showMerge || showDelete;
  // When Edit is the lone second-row action (e.g. a mapper with no
  // split/merge/delete), spell it out rather than leaving a single bare icon.
  const editAlone = showEdit && !showSplit && !showMerge && !showDelete;

  async function handleDownload() {
    if (!unlocked) return;
    try {
      const key = await getKey(mapsetId);
      if (!key) return;
      // Merge the section with the active base so positive BPM timing points
      // (which live on DifficultyBaseOsuVersion, not on the section) are
      // included — otherwise the file opens with no timing in the editor.
      const assembled = await assembleSectionOsu({
        difficultyId,
        sectionId: section.id,
        mapsetId,
        key,
        sortOrder: section.sortOrder,
      });
      // Now that we know the section version number, rewrite [Metadata]
      // Version so the editor shows e.g. "Intro_version_3" rather than the
      // parent difficulty name, and use the same string in the filename.
      const diffName = `${section.name}_version_${assembled.sectionVersion}`;
      const { content: finalContent, metadata } = withMetadataVersion(
        parseOsuFile(assembled.content),
        diffName,
      );
      const filename = composeOsuFilename({
        artist: metadata.artist,
        title: metadata.title,
        mapsetTitle,
        diffName,
      });
      const blob = new Blob([finalContent], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      logger.warn(`Failed to download section ${section.id}:`, err);
    }
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4" data-testid="section-detail-panel">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-white">{section.name}</h3>
          <p className="text-sm text-gray-400">
            {formatTime(section.startTimeMs)} – {formatTime(section.endTimeMs)}
          </p>
          {/* Always render this line — even before the latest version loads on
              demand — so the panel height stays stable. Until (or unless) a
              version exists, show a "No uploads yet" placeholder rather than
              nothing. */}
          <p className="text-xs text-gray-500 mt-0.5">
            {!latestVersion
              ? t('sectionDetail.latestUploadPlaceholder')
              : latestVersion.uploaded_by !== section.assignedTo
                ? t('sectionDetail.latestUploadBy', {
                    time: new Date(latestVersion.created_at).toLocaleString(),
                    username: membersById?.get(latestVersion.uploaded_by)?.username ?? t('sectionDetail.unknownMember'),
                  })
                : t('sectionDetail.latestUpload', {
                    time: new Date(latestVersion.created_at).toLocaleString(),
                  })}
          </p>
          {/* Assignment row */}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {section.assignedTo ? (
              <span className="text-xs text-blue-400 font-medium">
                {t('sectionDetail.assignedTo', {
                  username: membersById?.get(section.assignedTo)?.username ?? t('sectionDetail.unknownMember'),
                })}
              </span>
            ) : (
              <span className="text-xs text-gray-500 italic">{t('sectionDetail.unassigned')}</span>
            )}
            {isOwner && onAssignSection && (
              showAssignSelect ? (
                <select
                  autoFocus
                  className="text-xs bg-gray-700 text-white border border-gray-600 rounded px-1 py-0.5"
                  defaultValue={section.assignedTo ?? ''}
                  onBlur={() => setShowAssignSelect(false)}
                  onChange={(e) => {
                    setShowAssignSelect(false);
                    void onAssignSection(section.id, e.target.value || null);
                  }}
                >
                  {section.assignedTo && !membersById?.has(section.assignedTo) && (
                    <option value={section.assignedTo} disabled>
                      {t('sectionDetail.assigneeNotMember')}
                    </option>
                  )}
                  <option value="">{t('sectionDetail.assignUnassigned')}</option>
                  {Array.from(membersById?.values() ?? [])
                    .filter((m) => m.role !== 'modder')
                    .map((m) => (
                      <option key={m.user_id} value={m.user_id}>{m.username}</option>
                    ))}
                </select>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowAssignSelect(true)}
                  className="text-xs text-gray-400 hover:text-white underline"
                >
                  {t('sectionDetail.assignChange')}
                </button>
              )
            )}
            {!isOwner && role === 'mapper' && !section.assignedTo && onAssignSection && (
              <button
                type="button"
                onClick={() => void onAssignSection(section.id, currentUserId)}
                className="text-xs text-green-400 hover:text-green-300 underline"
              >
                {t('sectionDetail.claim')}
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          {/* Row 1 — Download, Upload, Version history. All icon-only except
              Version history (icon + text); tooltips/aria-labels carry the
              action name. */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDownload}
              aria-label={t('sectionDetail.downloadOsu')}
              title={t('sectionDetail.downloadOsu')}
              className={ICON_BTN}
            >
              <DownloadIcon />
            </button>
            {canEditStructure && (
              <OsuUploadButton
                difficultyId={difficultyId}
                sectionId={section.id}
                mapsetId={mapsetId}
                role={role}
                sectionRange={{ start: section.startTimeMs, end: section.endTimeMs }}
                assignedToUserId={section.assignedTo}
                currentUserId={currentUserId}
                assignedToUsername={
                  section.assignedTo
                    ? (membersById?.get(section.assignedTo)?.username ?? null)
                    : null
                }
                iconOnly
              />
            )}
            <button
              type="button"
              onClick={() => setShowHistory(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
            >
              <HistoryIcon />
              {t('sectionDetail.versionHistory')}
            </button>
          </div>

          {/* Row 2 — Edit + structural/destructive actions: Edit, Split, Merge,
              Delete. Edit spells out its label when alone; Delete always does. */}
          {hasStructureRow && (
            <div className="flex items-center gap-2">
              {showEdit && (
                <button
                  type="button"
                  onClick={() => onEditSection!(section)}
                  aria-label={editAlone ? undefined : t('sectionDetail.edit')}
                  title={editAlone ? undefined : t('sectionDetail.edit')}
                  className={
                    editAlone
                      ? 'inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors'
                      : ICON_BTN
                  }
                >
                  <EditIcon />
                  {editAlone && t('sectionDetail.editSection')}
                </button>
              )}
              {showSplit && (
                <button
                  type="button"
                  onClick={() => onSplitSection!(section)}
                  aria-label={t('sectionDetail.split')}
                  title={t('sectionDetail.split')}
                  className={ICON_BTN}
                >
                  <SplitIcon />
                </button>
              )}
              {showMerge && (
                <button
                  type="button"
                  onClick={() => {
                    const ok = window.confirm(
                      t('sectionDetail.mergeConfirm', { name: section.name, nextName: nextSection!.name }),
                    );
                    if (ok) void onMergeSection!(section);
                  }}
                  aria-label={t('sectionDetail.merge')}
                  title={t('sectionDetail.merge')}
                  className={ICON_BTN}
                >
                  <MergeIcon />
                </button>
              )}
              {showDelete && (
                <button
                  type="button"
                  onClick={() => {
                    const ok = window.confirm(t('sectionDetail.deleteConfirm', { name: section.name }));
                    if (ok) void onDeleteSection!(section);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-xs font-medium rounded transition-colors"
                >
                  <TrashIcon />
                  {t('sectionDetail.delete')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {showHistory && (
        <OsuVersionHistory
          difficultyId={difficultyId}
          sectionId={section.id}
          membersById={membersById}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}
