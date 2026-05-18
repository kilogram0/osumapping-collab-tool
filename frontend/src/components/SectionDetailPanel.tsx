import { useMemo, useState } from 'react';
import type { Post, MemberWithUser } from '../api/endpoints';
import type { DecryptedSection } from './SectionList';
import type { DecryptedPost } from '../types';
import PostCard from './PostCard';
import CreatePostForm from './CreatePostForm';
import OsuUploadButton from './OsuUploadButton';
import OsuVersionHistory from './OsuVersionHistory';
import { downloadSectionOsu } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { decrypt, sectionOsuVersionAad } from '../utils/crypto';
import { logger } from '../utils/logger';

interface SectionDetailPanelProps {
  section: DecryptedSection;
  /** True when this is the last section in the difficulty; the upper-bound
   *  check is inclusive so a post landing exactly on the song's final ms
   *  isn't excluded from every section. */
  isLastSection?: boolean;
  posts: DecryptedPost[];
  mapsetId: string;
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
  onEditSection?: (section: DecryptedSection) => void;
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
  difficultyId,
  currentUserId,
  isOwner,
  role,
  canEditStructure,
  membersById,
  onCreatePost,
  onUpdatePost,
  onDeletePost,
  onEditSection,
}: SectionDetailPanelProps) {
  const { isUnlocked, getKey } = useEncryption();
  const unlocked = isUnlocked(mapsetId);
  const [showHistory, setShowHistory] = useState(false);
  const [replyingTo, setReplyingTo] = useState<DecryptedPost | null>(null);
  const [editingPost, setEditingPost] = useState<DecryptedPost | null>(null);
  const [editingPostBody, setEditingPostBody] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  const sectionPosts = useMemo(() => {
    return posts.filter((p) => {
      if (p.extractedMs === null) return false;
      if (p.extractedMs < section.startTimeMs) return false;
      // Half-open [start, end) so a post on a section boundary belongs only
      // to the later section. The final section keeps an inclusive upper
      // bound so posts at the song's last ms still appear somewhere.
      return isLastSection ? p.extractedMs <= section.endTimeMs : p.extractedMs < section.endTimeMs;
    });
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
      const resp = await downloadSectionOsu(difficultyId, section.id);
      const plaintext = await decrypt(key, resp.encrypted_content, sectionOsuVersionAad(resp.id, mapsetId));
      const blob = new Blob([plaintext], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${section.name.replace(/[^a-z0-9]/gi, '_')}.osu`;
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
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canEditStructure && (
            <>
              <OsuUploadButton
                difficultyId={difficultyId}
                sectionId={section.id}
                mapsetId={mapsetId}
                role={role}
              />
              {onEditSection && (
                <button
                  type="button"
                  onClick={() => onEditSection(section)}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
                >
                  Edit
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={handleDownload}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
          >
            Download .osu
          </button>
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
          >
            Version History
          </button>
        </div>
      </div>

      {/* Posts */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium text-gray-300">
            Posts ({sectionPosts.length})
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
            {showCreateForm ? 'Hide Form' : 'New Post'}
          </button>
        </div>

        {showCreateForm && !replyingTo && !editingPost && (
          <div className="mb-4">
            <CreatePostForm
              mapsetId={mapsetId}
              difficultyId={difficultyId}
              onSubmit={handleCreatePost}
              onCancel={() => setShowCreateForm(false)}
            />
          </div>
        )}

        <div className="space-y-3">
          {postTree.topLevel.map((post) => renderPostNode(post, 0))}
        </div>

        {sectionPosts.length === 0 && (
          <p className="text-sm text-gray-500 italic">
            No posts for this section yet.
          </p>
        )}
      </div>

      {showHistory && (
        <OsuVersionHistory
          difficultyId={difficultyId}
          sectionId={section.id}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}
