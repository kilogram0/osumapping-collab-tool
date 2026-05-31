import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Post, MemberWithUser } from '../api/endpoints';
import type { DecryptedPost } from '../types';
import PostCard from './PostCard';
import CollapsibleBranch from './CollapsibleBranch';
import ResolveEvent from './ResolveEvent';
import CreatePostForm from './CreatePostForm';
import { deriveResolvedRootIds, canBeResolved, isStatusReply } from '../utils/resolveUtils';
import { compareRootPostOrder, compareReplyOrder } from '../utils/postSort';

type PostPayload = {
  id: string;
  tag: Post['tag'];
  encrypted_body: string;
  parent_id?: string | null;
};

interface PostsPanelProps {
  /** The set of posts to display — already filtered to the section in section
   *  view, or the full difficulty list in all-posts view. */
  posts: DecryptedPost[];
  mapsetId: string;
  difficultyId: string;
  currentUserId: string;
  isOwner: boolean;
  membersById?: Map<string, MemberWithUser>;
  /** False for ghost members — hides the always-open create form. */
  canPost: boolean;
  /** Prepended as a timestamp on new posts with no timestamp (section start). */
  defaultTimestampMs?: number | null;
  /** True when no section is selected (the "Show All Posts" toggle is active). */
  showAllPostsActive: boolean;
  showOnlyUnresolved: boolean;
  onSelectAllPosts: () => void;
  onToggleUnresolved: () => void;
  onCreatePost: (payload: PostPayload) => void | Promise<void>;
  onUpdatePost: (payload: PostPayload) => void | Promise<void>;
  onDeletePost: (postId: string) => void | Promise<void>;
  loading?: boolean;
}

const MAX_REPLY_DEPTH = 10;

export default function PostsPanel({
  posts,
  mapsetId,
  difficultyId,
  currentUserId,
  isOwner,
  membersById,
  canPost,
  defaultTimestampMs = null,
  showAllPostsActive,
  showOnlyUnresolved,
  onSelectAllPosts,
  onToggleUnresolved,
  onCreatePost,
  onUpdatePost,
  onDeletePost,
  loading = false,
}: PostsPanelProps) {
  const { t } = useTranslation();
  // Reply/edit interaction state is local to the panel — the always-open main
  // create form is rendered independently, so opening a reply/edit never hides it.
  const [replyingTo, setReplyingTo] = useState<DecryptedPost | null>(null);
  const [editingPost, setEditingPost] = useState<DecryptedPost | null>(null);
  const [editingPostBody, setEditingPostBody] = useState('');

  const postTree = useMemo(() => {
    const topLevel: DecryptedPost[] = [];
    const replyMap = new Map<string, DecryptedPost[]>();

    for (const post of posts) {
      if (post.parent_id === null) {
        if (!isStatusReply(post.tag)) topLevel.push(post);
      } else {
        const siblings = replyMap.get(post.parent_id) ?? [];
        siblings.push(post);
        replyMap.set(post.parent_id, siblings);
      }
    }

    topLevel.sort(compareRootPostOrder);
    for (const replies of replyMap.values()) replies.sort(compareReplyOrder);

    return { topLevel, replyMap };
  }, [posts]);

  const resolvedPostIds = useMemo(() => deriveResolvedRootIds(postTree), [postTree]);

  const visibleTopLevel = useMemo(() => {
    if (!showOnlyUnresolved) return postTree.topLevel;
    return postTree.topLevel.filter(
      (p) => canBeResolved(p.tag) && !resolvedPostIds.has(p.id),
    );
  }, [showOnlyUnresolved, postTree.topLevel, resolvedPostIds]);

  // onUpdatePost re-throws on failure so CreatePostForm keeps its draft; only
  // close the edit form once the update has actually succeeded.
  async function handleUpdatePost(payload: PostPayload) {
    await onUpdatePost(payload);
    setEditingPost(null);
    setEditingPostBody('');
  }

  function startEditing(post: DecryptedPost) {
    setReplyingTo(null);
    setEditingPost(post);
    setEditingPostBody(post.decryptedBody);
  }

  function renderReplyNode(post: DecryptedPost, depth: number): JSX.Element | null {
    if (depth > MAX_REPLY_DEPTH) return null;
    const replies = postTree.replyMap.get(post.id) ?? [];
    const isEditingThis = editingPost?.id === post.id;
    return (
      <div key={post.id} id={`post-${post.id}`} className="mt-2 ml-8 border-l-2 border-gray-700 pl-4">
        <PostCard
          post={post}
          mapsetId={mapsetId}
          currentUserId={currentUserId}
          isOwner={isOwner}
          decryptedBody={post.decryptedBody}
          author={membersById?.get(post.author_id) ?? null}
          showReplyButton={false}
          onEdit={(p) => startEditing(p as DecryptedPost)}
          onDelete={onDeletePost}
        />

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

        {replies.map((reply) => {
          // Status replies (resolve/reopen) only render under the root via
          // ResolveEvent — silently skip them at deeper levels.
          if (isStatusReply(reply.tag)) return null;
          return renderReplyNode(reply, depth + 1);
        })}
      </div>
    );
  }

  function renderRootPostNode(post: DecryptedPost): JSX.Element {
    const replies = postTree.replyMap.get(post.id) ?? [];
    const isReplyingToThis = replyingTo?.id === post.id;
    const isEditingThis = editingPost?.id === post.id;
    const isResolved = resolvedPostIds.has(post.id);
    return (
      <CollapsibleBranch key={post.id} userId={currentUserId} postId={post.id}>
        {(collapsed, toggle) => (
          <div id={`post-${post.id}`}>
            <PostCard
              post={post}
              mapsetId={mapsetId}
              currentUserId={currentUserId}
              isOwner={isOwner}
              decryptedBody={post.decryptedBody}
              author={membersById?.get(post.author_id) ?? null}
              showReplyButton
              isResolved={isResolved}
              isCollapsed={collapsed}
              onToggleCollapse={toggle}
              onReply={(p) => {
                setEditingPost(null);
                setReplyingTo(p as DecryptedPost);
              }}
              onEdit={(p) => startEditing(p as DecryptedPost)}
              onDelete={onDeletePost}
            />

            {!collapsed && (
              <>
                {isReplyingToThis && (
                  <div className="mt-2 ml-8 border-l-2 border-gray-700 pl-4">
                    <CreatePostForm
                      mapsetId={mapsetId}
                      difficultyId={difficultyId}
                      onSubmit={async (payload) => {
                        await onCreatePost(payload);
                        setReplyingTo(null);
                      }}
                      onCancel={() => setReplyingTo(null)}
                      parentPost={post}
                      resolveAction={canBeResolved(post.tag) ? (isResolved ? 'reopen' : 'resolve') : undefined}
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

                {replies.map((reply) => {
                  if (isStatusReply(reply.tag)) {
                    return (
                      <div key={reply.id} className="mt-2 ml-8 border-l-2 border-gray-700 pl-4">
                        <ResolveEvent
                          post={reply}
                          author={membersById?.get(reply.author_id) ?? null}
                          currentUserId={currentUserId}
                          isOwner={isOwner}
                          onDelete={onDeletePost}
                        />
                      </div>
                    );
                  }
                  return renderReplyNode(reply, 1);
                })}
              </>
            )}
          </div>
        )}
      </CollapsibleBranch>
    );
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4" data-testid="posts-panel">
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <button
          type="button"
          onClick={onSelectAllPosts}
          className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
            showAllPostsActive
              ? 'bg-blue-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          {t('mapsetPage.showAllPosts')}
        </button>
        <button
          type="button"
          onClick={onToggleUnresolved}
          aria-pressed={showOnlyUnresolved}
          className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
            showOnlyUnresolved
              ? 'bg-orange-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          {t('mapsetPage.showOnlyUnresolved')}
        </button>
      </div>

      {canPost && (
        <div className="mb-6">
          <CreatePostForm
            mapsetId={mapsetId}
            difficultyId={difficultyId}
            onSubmit={onCreatePost}
            defaultTimestampMs={defaultTimestampMs}
          />
        </div>
      )}

      {loading && <p className="text-gray-400">{t('mapsetPage.loadingPosts')}</p>}

      <div className="space-y-4">
        {visibleTopLevel.map((post) => renderRootPostNode(post))}
      </div>

      {visibleTopLevel.length === 0 && !loading && (
        <p className="text-gray-400 italic">
          {posts.length === 0 ? t('mapsetPage.noPostsYet') : t('mapsetPage.noUnresolvedPosts')}
        </p>
      )}
    </div>
  );
}
