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
        <div className="flex items-center gap-2 shrink-0">
          {canEditStructure && (
            <>
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
              />
              {onEditSection && (
                <button
                  type="button"
                  onClick={() => onEditSection(section)}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
                >
                  {t('sectionDetail.edit')}
                </button>
              )}
            </>
          )}
          {isOwner && onSplitSection && (
            <button
              type="button"
              onClick={() => onSplitSection(section)}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
            >
              {t('sectionDetail.split')}
            </button>
          )}
          {isOwner && nextSection && onMergeSection && (
            <button
              type="button"
              onClick={() => {
                const ok = window.confirm(
                  t('sectionDetail.mergeConfirm', { name: section.name, nextName: nextSection.name }),
                );
                if (ok) void onMergeSection(section);
              }}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
            >
              {t('sectionDetail.merge')}
            </button>
          )}
          {isOwner && onDeleteSection && (
            <button
              type="button"
              onClick={() => {
                const ok = window.confirm(t('sectionDetail.deleteConfirm', { name: section.name }));
                if (ok) void onDeleteSection(section);
              }}
              className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-xs font-medium rounded transition-colors"
            >
              {t('sectionDetail.delete')}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownload}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
          >
            {t('sectionDetail.downloadOsu')}
          </button>
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
          >
            {t('sectionDetail.versionHistory')}
          </button>
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
