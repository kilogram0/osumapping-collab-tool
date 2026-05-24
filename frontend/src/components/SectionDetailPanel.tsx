import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Post, MemberWithUser } from '../api/endpoints';
import type { DecryptedSection } from './SectionList';
import type { DecryptedPost } from '../types';
import PostCard from './PostCard';
import CreatePostForm from './CreatePostForm';
import OsuUploadButton from './OsuUploadButton';
import OsuVersionHistory from './OsuVersionHistory';
import { useEncryption } from '../contexts/EncryptionContext';
import { assembleSectionOsu } from '../utils/sectionDownload';
import { composeOsuFilename } from '../utils/osuFilename';
import { parseOsuFile, withMetadataVersion } from '../utils/osuParser';
import { logger } from '../utils/logger';

interface SectionDetailPanelProps {
  section: DecryptedSection;
  /** True when this is the last section in the difficulty; the upper-bound
   *  check is inclusive so a post landing exactly on the song's final ms
   *  isn't excluded from every section. */
  isLastSection?: boolean;
  posts: DecryptedPost[];
  mapsetId: string;
  mapsetTitle: string;
  difficultyId: string;
  currentUserId: string;
  isOwner: boolean;
  role?: 'owner' | 'mapper' | 'modder' | null;
  canEditStructure: boolean;
  /** Lookup from user_id → member profile for resolving post author display. */
  membersById?: Map<string, MemberWithUser>;
  onCreatePost: (payload: {
    id: string;
    tag: Post['tag'];
    encrypted_body: string;
    parent_id?: string | null;
  }) => void | Promise<void>;
  onUpdatePost: (payload: {
    id: string;
    tag: Post['tag'];
    encrypted_body: string;
    parent_id?: string | null;
  }) => void | Promise<void>;
  onDeletePost: (postId: string) => void | Promise<void>;
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
  isLastSection = false,
  posts,
  mapsetId,
  mapsetTitle,
  difficultyId,
  currentUserId,
  isOwner,
  role,
  canEditStructure,
  membersById,
  onCreatePost,
  onUpdatePost,
  onDeletePost,
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
  const [showAssignSelect, setShowAssignSelect] = useState(false);
  const [replyingTo, setReplyingTo] = useState<DecryptedPost | null>(null);
  const [editingPost, setEditingPost] = useState<DecryptedPost | null>(null);
  const [editingPostBody, setEditingPostBody] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  const sectionPosts = useMemo(() => {
    const postById = new Map(posts.map((p) => [p.id, p]));

    // Walk the parent chain to find the root (top-level) post id.
    // Visited set guards against cycles in malformed data.
    function findRootId(postId: string): string {
      let current = postId;
      const visited = new Set<string>();
      while (true) {
        if (visited.has(current)) return current;
        visited.add(current);
        const post = postById.get(current);
        if (!post || post.parent_id === null) return current;
        current = post.parent_id;
      }
    }

    const inSectionByTimestamp = (p: DecryptedPost) => {
      if (p.extractedMs === null) return false;
      if (p.extractedMs < section.startTimeMs) return false;
      // Half-open [start, end) — final section uses inclusive upper bound.
      return isLastSection ? p.extractedMs <= section.endTimeMs : p.extractedMs < section.endTimeMs;
    };

    // Top-level posts whose timestamp falls in this section anchor the threads.
    const sectionRootIds = new Set(
      posts.filter((p) => p.parent_id === null && inSectionByTimestamp(p)).map((p) => p.id),
    );

    // A top-level post belongs if its timestamp is in range.
    // A reply belongs if its root ancestor is a post in this section,
    // regardless of the reply's own timestamp (replies reference context,
    // not necessarily the same position in the map).
    return posts.filter((p) =>
      p.parent_id === null ? sectionRootIds.has(p.id) : sectionRootIds.has(findRootId(p.id)),
    );
  }, [posts, section, isLastSection]);

  // Build reply trees for section posts
  const postTree = useMemo(() => {
    const topLevel: DecryptedPost[] = [];
    const replyMap = new Map<string, DecryptedPost[]>();

    for (const post of sectionPosts) {
      if (post.parent_id === null) {
        topLevel.push(post);
      } else {
        const siblings = replyMap.get(post.parent_id) ?? [];
        siblings.push(post);
        replyMap.set(post.parent_id, siblings);
      }
    }

    return { topLevel, replyMap };
  }, [sectionPosts]);

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

  function handleCreatePost(payload: {
    id: string;
    tag: Post['tag'];
    encrypted_body: string;
    parent_id?: string | null;
  }) {
    onCreatePost(payload);
    setReplyingTo(null);
    setShowCreateForm(false);
  }

  function handleUpdatePost(payload: {
    id: string;
    tag: Post['tag'];
    encrypted_body: string;
    parent_id?: string | null;
  }) {
    onUpdatePost(payload);
    setEditingPost(null);
    setEditingPostBody('');
  }

  function renderPostNode(post: DecryptedPost, depth: number): JSX.Element | null {
    const MAX_REPLY_DEPTH = 10;
    if (depth > MAX_REPLY_DEPTH) return null;
    const replies = postTree.replyMap.get(post.id) ?? [];
    const isReplyingToThis = replyingTo?.id === post.id;
    const isEditingThis = editingPost?.id === post.id;
    return (
      <div key={post.id} className={depth > 0 ? 'mt-2 ml-8 border-l-2 border-gray-700 pl-4' : ''}>
        <PostCard
          post={post}
          mapsetId={mapsetId}
          currentUserId={currentUserId}
          isOwner={isOwner}
          decryptedBody={post.decryptedBody}
          author={membersById?.get(post.author_id) ?? null}
          showReplyButton={depth === 0}
          onReply={(p) => {
            setEditingPost(null);
            setShowCreateForm(false);
            setReplyingTo(p as DecryptedPost);
          }}
          onEdit={(p) => {
            setReplyingTo(null);
            setShowCreateForm(false);
            setEditingPost(p as DecryptedPost);
            setEditingPostBody((p as DecryptedPost).decryptedBody);
          }}
          onDelete={onDeletePost}
        />

        {isReplyingToThis && (
          <div className={depth === 0 ? 'mt-2 ml-8 border-l-2 border-gray-700 pl-4' : 'mt-2'}>
            <CreatePostForm
              mapsetId={mapsetId}
              difficultyId={difficultyId}
              onSubmit={handleCreatePost}
              onCancel={() => setReplyingTo(null)}
              parentPost={post}
            />
          </div>
        )}

        {isEditingThis && (
          <div className="mt-2">
            <CreatePostForm
              mapsetId={mapsetId}
              difficultyId={difficultyId}
              onSubmit={handleUpdatePost}
              onCancel={() => {
                setEditingPost(null);
                setEditingPostBody('');
              }}
              editingPost={post}
              initialBody={editingPostBody}
            />
          </div>
        )}

        {replies.map((reply) => renderPostNode(reply, depth + 1))}
      </div>
    );
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4" data-testid="section-detail-panel">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-lg font-semibold text-white">{section.name}</h3>
          <p className="text-sm text-gray-400">
            {formatTime(section.startTimeMs)} – {formatTime(section.endTimeMs)}
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

      {/* Posts */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium text-gray-300">
            {t('sectionDetail.posts', { count: sectionPosts.length })}
          </h4>
          <button
            type="button"
            onClick={() => {
              setReplyingTo(null);
              setEditingPost(null);
              setShowCreateForm((prev) => !prev);
            }}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded transition-colors"
          >
            {showCreateForm ? t('sectionDetail.hideForm') : t('sectionDetail.newPost')}
          </button>
        </div>

        {showCreateForm && !replyingTo && !editingPost && (
          <div className="mb-4">
            <CreatePostForm
              mapsetId={mapsetId}
              difficultyId={difficultyId}
              onSubmit={handleCreatePost}
              onCancel={() => setShowCreateForm(false)}
              defaultTimestampMs={section.startTimeMs}
            />
          </div>
        )}

        <div className="space-y-3">
          {postTree.topLevel.map((post) => renderPostNode(post, 0))}
        </div>

        {sectionPosts.length === 0 && (
          <p className="text-sm text-gray-500 italic">
            {t('sectionDetail.empty')}
          </p>
        )}
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
