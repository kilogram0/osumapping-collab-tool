import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import BaseVersionHistory from '../components/BaseVersionHistory';
import CreateDifficultyModal from '../components/CreateDifficultyModal';
import CreatePostForm from '../components/CreatePostForm';
import CreateSectionModal from '../components/CreateSectionModal';
import DifficultyTabs from '../components/DifficultyTabs';
import EditSectionModal from '../components/EditSectionModal';
import PassphraseModal from '../components/PassphraseModal';
import PostCard from '../components/PostCard';
import SectionList, { type DecryptedSection } from '../components/SectionList';
import { useAuth } from '../hooks/useAuth';
import { useEncryption } from '../contexts/EncryptionContext';
import {
  useCreatePost,
  useDeletePost,
  useDifficultyDetail,
  useDifficulties,
  useUpdatePost,
} from '../hooks/useDifficulty';
import { useMapset, useMyMembership } from '../hooks/useMapset';
import { decrypt, decodeJsonEnvelope, mapsetFieldAad, postFieldAad } from '../utils/crypto';
import { extractFirstTimestamp } from '../utils/extractTimestamp';
import { logger } from '../utils/logger';
import type { Post } from '../api/endpoints';

export interface DecryptedPost extends Post {
  decryptedBody: string;
  extractedMs: number | null;
}

export default function MapsetPage() {
  const { id } = useParams<{ id: string }>();
  const mapsetId = id ?? '';
  const { data: mapset, isLoading: mapsetLoading, isError: mapsetError } = useMapset(mapsetId);
  const { data: myMembership } = useMyMembership(mapsetId);
  const { data: difficulties, isLoading: difficultiesLoading } = useDifficulties(mapsetId);
  const [selectedDifficultyId, setSelectedDifficultyId] = useState<string | null>(null);
  const { data: difficultyDetail, isLoading: detailLoading } = useDifficultyDetail(selectedDifficultyId);
  const { isUnlocked, getKey } = useEncryption();
  const { user } = useAuth();
  const navigate = useNavigate();
  const unlocked = isUnlocked(mapsetId);

  const createPostMutation = useCreatePost(selectedDifficultyId ?? '');
  const updatePostMutation = useUpdatePost(selectedDifficultyId ?? '');
  const deletePostMutation = useDeletePost(selectedDifficultyId ?? '');

  const [showCreateDifficulty, setShowCreateDifficulty] = useState(false);
  const [showCreateSection, setShowCreateSection] = useState(false);
  const [showEditSection, setShowEditSection] = useState(false);
  const [showBaseHistory, setShowBaseHistory] = useState(false);
  const [editingSection, setEditingSection] = useState<DecryptedSection | null>(null);
  const [decryptedSections, setDecryptedSections] = useState<DecryptedSection[]>([]);
  const [decryptedDescription, setDecryptedDescription] = useState<string | null>(null);
  const [songLengthMs, setSongLengthMs] = useState<number | null>(null);
  const [decryptedPosts, setDecryptedPosts] = useState<DecryptedPost[]>([]);
  const [replyingTo, setReplyingTo] = useState<Post | null>(null);
  const [editingPost, setEditingPost] = useState<Post | null>(null);
  const [editingPostBody, setEditingPostBody] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  const isOwner = myMembership?.role === 'owner';
  const canEditStructure = isOwner || myMembership?.role === 'mapper';

  useEffect(() => {
    if (difficulties && difficulties.length > 0 && selectedDifficultyId === null) {
      setSelectedDifficultyId(difficulties[0].id);
    }
  }, [difficulties, selectedDifficultyId]);

  useEffect(() => {
    if (!unlocked || !mapset) {
      setDecryptedDescription(null);
      setSongLengthMs(null);
      return;
    }

    let cancelled = false;

    async function decryptMetadata() {
      try {
        const key = await getKey(mapsetId);
        if (!key || cancelled) return;

        const results = await Promise.allSettled([
          mapset.encrypted_description
            ? decrypt(key, mapset.encrypted_description, mapsetFieldAad(mapsetId))
            : Promise.resolve(null),
          decrypt(key, mapset.encrypted_song_length_ms, mapsetFieldAad(mapsetId)),
        ]);

        if (cancelled) return;

        const descResult = results[0];
        if (descResult.status === 'fulfilled' && descResult.value !== null) {
          setDecryptedDescription(descResult.value);
        }

        const songResult = results[1];
        if (songResult.status === 'fulfilled') {
          setSongLengthMs(decodeJsonEnvelope(songResult.value));
        }
      } catch (err) {
        logger.warn('Failed to decrypt mapset metadata:', err);
      }
    }

    decryptMetadata();
    return () => { cancelled = true; };
  }, [unlocked, mapset, mapsetId, getKey]);

  // Decrypt posts whenever the difficulty detail changes
  useEffect(() => {
    if (!unlocked || !difficultyDetail?.posts) {
      setDecryptedPosts([]);
      return;
    }

    let cancelled = false;

    async function decryptPosts() {
      try {
        const key = await getKey(mapsetId);
        if (!key || cancelled) return;

        const results: DecryptedPost[] = await Promise.all(
          difficultyDetail.posts.map(async (post): Promise<DecryptedPost> => {
            try {
              const plaintext = await decrypt(key, post.encrypted_body, postFieldAad(post.id, mapsetId));
              const extracted = extractFirstTimestamp(plaintext);
              return {
                ...post,
                decryptedBody: plaintext,
                extractedMs: extracted?.ms ?? null,
              };
            } catch (_err) {
              logger.warn(`Failed to decrypt post ${post.id}:`, _err);
              return {
                ...post,
                decryptedBody: '[Failed to decrypt]',
                extractedMs: null,
              };
            }
          }),
        );

        if (!cancelled) {
          // Sort by extracted timestamp (if any), then by created_at
          results.sort((a, b) => {
            if (a.extractedMs !== null && b.extractedMs !== null) {
              return a.extractedMs - b.extractedMs;
            }
            if (a.extractedMs !== null) return -1;
            if (b.extractedMs !== null) return 1;
            return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
          });
          setDecryptedPosts(results);
        }
      } catch (err) {
        logger.warn('Failed to decrypt posts:', err);
      }
    }

    decryptPosts();
    return () => { cancelled = true; };
  }, [unlocked, difficultyDetail, mapsetId, getKey]);

  // Build reply trees: top-level posts + their replies
  const postTree = useMemo(() => {
    const topLevel: DecryptedPost[] = [];
    const replyMap = new Map<string, DecryptedPost[]>();

    for (const post of decryptedPosts) {
      if (post.parent_id === null) {
        topLevel.push(post);
      } else {
        const siblings = replyMap.get(post.parent_id) ?? [];
        siblings.push(post);
        replyMap.set(post.parent_id, siblings);
      }
    }

    return { topLevel, replyMap };
  }, [decryptedPosts]);

  function renderPostNode(post: DecryptedPost, depth: number): JSX.Element | null {
    const MAX_REPLY_DEPTH = 10;
    if (depth > MAX_REPLY_DEPTH) return null;
    const replies = postTree.replyMap.get(post.id) ?? [];
    return (
      <div key={post.id} className={depth > 0 ? 'mt-2 ml-8 border-l-2 border-gray-700 pl-4' : ''}>
        <PostCard
          post={post}
          mapsetId={mapsetId}
          currentUserId={user?.id ?? ''}
          isOwner={isOwner}
          decryptedBody={post.decryptedBody}
          onReply={(p) => {
            setEditingPost(null);
            setShowCreateForm(false);
            setReplyingTo(p);
          }}
          onEdit={(p) => {
            setReplyingTo(null);
            setShowCreateForm(false);
            setEditingPost(p);
            const dp = decryptedPosts.find((x) => x.id === p.id);
            setEditingPostBody(dp?.decryptedBody ?? '');
          }}
          onDelete={handleDeletePost}
        />
        {replies.map((reply) => renderPostNode(reply, depth + 1))}
      </div>
    );
  }

  function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  async function handleCreatePost(payload: {
    id: string;
    tag: Post['tag'];
    encrypted_body: string;
    parent_id?: string | null;
  }) {
    await createPostMutation.mutateAsync(payload);
    setReplyingTo(null);
    setShowCreateForm(false);
  }

  async function handleUpdatePost(payload: {
    id: string;
    tag: Post['tag'];
    encrypted_body: string;
    parent_id?: string | null;
  }) {
    await updatePostMutation.mutateAsync({ postId: payload.id, payload: { encrypted_body: payload.encrypted_body } });
    setEditingPost(null);
    setEditingPostBody('');
  }

  async function handleDeletePost(postId: string) {
    if (!confirm('Are you sure you want to delete this post?')) return;
    await deletePostMutation.mutateAsync(postId);
  }

  if (!id) return null;
  if (mapsetLoading) return <div className="min-h-screen bg-gray-900 text-white p-8">Loading…</div>;
  if (mapsetError || !mapset) {
    return <div className="min-h-screen bg-gray-900 text-white p-8 text-red-400">Mapset not found.</div>;
  }

  if (!unlocked) {
    return (
      <div className="min-h-screen bg-gray-900">
        <PassphraseModal
          mapset={mapset}
          onSuccess={() => {}}
          onCancel={() => navigate('/dashboard')}
        />
      </div>
    );
  }

  const sections = difficultyDetail?.sections ?? [];

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-blue-400">{mapset.title}</h1>
          {decryptedDescription && (
            <p className="text-gray-300 mt-2">{decryptedDescription}</p>
          )}
          {songLengthMs !== null && (
            <p className="text-sm text-gray-400 mt-1">{formatDuration(songLengthMs)}</p>
          )}
        </div>

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-200">Difficulties</h2>
          {canEditStructure && (
            <button
              type="button"
              onClick={() => setShowCreateDifficulty(true)}
              className="px-3 py-1.5 bg-pink-600 hover:bg-pink-500 text-white text-sm font-medium rounded transition-colors"
            >
              Add Difficulty
            </button>
          )}
        </div>

        {difficultiesLoading && <p className="text-gray-400">Loading difficulties…</p>}

        {difficulties && difficulties.length > 0 && (
          <div className="mb-6">
            <DifficultyTabs
              difficulties={difficulties}
              selectedId={selectedDifficultyId}
              onSelect={setSelectedDifficultyId}
              mapsetId={mapsetId}
            />
          </div>
        )}

        {difficulties && difficulties.length === 0 && !difficultiesLoading && (
          <p className="text-gray-400 italic mb-6">No difficulties yet.</p>
        )}

        {selectedDifficultyId && (
          <div className="flex flex-col lg:flex-row gap-6">
            {/* Sections Sidebar */}
            <div className="lg:w-80 shrink-0">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-gray-200">Sections</h2>
                <div className="flex gap-2">
                  {canEditStructure && (
                    <button
                      type="button"
                      onClick={() => setShowCreateSection(true)}
                      className="px-3 py-1.5 bg-pink-600 hover:bg-pink-500 text-white text-sm font-medium rounded transition-colors"
                    >
                      Add Section
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowBaseHistory(true)}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
                  >
                    Base History
                  </button>
                </div>
              </div>
              {detailLoading && <p className="text-gray-400">Loading sections…</p>}
              <SectionList
                sections={sections}
                mapsetId={mapsetId}
                difficultyId={selectedDifficultyId}
                role={myMembership?.role}
                onEdit={(s) => {
                  setEditingSection(s);
                  setShowEditSection(true);
                }}
                onDecrypted={setDecryptedSections}
              />
              {sections.length === 0 && !detailLoading && (
                <p className="text-gray-400 italic">No sections yet.</p>
              )}
            </div>

            {/* Forum Thread */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-200">Forum</h2>
                <button
                  type="button"
                  onClick={() => {
                    setReplyingTo(null);
                    setEditingPost(null);
                    setShowCreateForm((prev) => !prev);
                  }}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors"
                >
                  {showCreateForm ? 'Hide Form' : 'New Post'}
                </button>
              </div>

              {showCreateForm && !replyingTo && !editingPost && (
                <div className="mb-6">
                  <CreatePostForm
                    mapsetId={mapsetId}
                    difficultyId={selectedDifficultyId}
                    onSubmit={handleCreatePost}
                    onCancel={() => setShowCreateForm(false)}
                  />
                </div>
              )}

              {replyingTo && (
                <div className="mb-6">
                  <CreatePostForm
                    mapsetId={mapsetId}
                    difficultyId={selectedDifficultyId}
                    onSubmit={handleCreatePost}
                    onCancel={() => setReplyingTo(null)}
                    parentPost={replyingTo}
                  />
                </div>
              )}

              {editingPost && (
                <div className="mb-6">
                  <CreatePostForm
                    mapsetId={mapsetId}
                    difficultyId={selectedDifficultyId}
                    onSubmit={handleUpdatePost}
                    onCancel={() => {
                      setEditingPost(null);
                      setEditingPostBody('');
                    }}
                    editingPost={editingPost}
                    initialBody={editingPostBody}
                  />
                </div>
              )}

              {detailLoading && <p className="text-gray-400">Loading posts…</p>}

              <div className="space-y-4">
                {postTree.topLevel.map((post) => renderPostNode(post, 0))}
              </div>

              {decryptedPosts.length === 0 && !detailLoading && (
                <p className="text-gray-400 italic">No posts yet. Be the first to post!</p>
              )}
            </div>
          </div>
        )}
      </div>

      {showCreateDifficulty && (
        <CreateDifficultyModal
          mapsetId={mapsetId}
          onSuccess={() => setShowCreateDifficulty(false)}
          onCancel={() => setShowCreateDifficulty(false)}
        />
      )}

      {showCreateSection && selectedDifficultyId && (
        <CreateSectionModal
          difficultyId={selectedDifficultyId}
          mapsetId={mapsetId}
          previousSections={decryptedSections}
          onSuccess={() => setShowCreateSection(false)}
          onCancel={() => setShowCreateSection(false)}
        />
      )}

      {showEditSection && editingSection && selectedDifficultyId && (
        <EditSectionModal
          difficultyId={selectedDifficultyId}
          mapsetId={mapsetId}
          sectionId={editingSection.id}
          initialName={editingSection.name}
          initialStartTimeMs={editingSection.startTimeMs}
          initialEndTimeMs={editingSection.endTimeMs}
          onSuccess={() => {
            setShowEditSection(false);
            setEditingSection(null);
          }}
          onCancel={() => {
            setShowEditSection(false);
            setEditingSection(null);
          }}
        />
      )}

      {showBaseHistory && selectedDifficultyId && (
        <BaseVersionHistory
          difficultyId={selectedDifficultyId}
          onClose={() => setShowBaseHistory(false)}
        />
      )}
    </div>
  );
}
