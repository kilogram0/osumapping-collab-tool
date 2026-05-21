import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import BaseVersionHistory from '../components/BaseVersionHistory';
import CreateDifficultyModal from '../components/CreateDifficultyModal';
import CreatePostForm from '../components/CreatePostForm';
import CreateSectionModal from '../components/CreateSectionModal';
import DifficultyTabs from '../components/DifficultyTabs';
import EditSectionModal from '../components/EditSectionModal';
import ImportBookmarksButton from '../components/ImportBookmarksButton';
import LanguageSwitcher from '../components/LanguageSwitcher';
import ManageMembersModal from '../components/ManageMembersModal';
import MergedDownloadButton from '../components/MergedDownloadButton';
import PassphraseModal from '../components/PassphraseModal';
import PostCard from '../components/PostCard';
import RenameDifficultyModal from '../components/RenameDifficultyModal';
import SectionDetailPanel from '../components/SectionDetailPanel';
import Timeline from '../components/Timeline';
import { useAuth } from '../hooks/useAuth';
import { useEncryption } from '../contexts/EncryptionContext';
import { useToast } from '../contexts/ToastContext';
import {
  useCreatePost,
  useDeleteDifficulty,
  useDeletePost,
  useDeleteSection,
  useDifficultyDetail,
  useDifficulties,
  useUpdatePost,
} from '../hooks/useDifficulty';
import { useMapset, useMembers, useMyMembership } from '../hooks/useMapset';
import { decrypt, decodeJsonEnvelope, mapsetFieldAad, postFieldAad, sectionFieldAad } from '../utils/crypto';
import { extractFirstTimestamp } from '../utils/extractTimestamp';
import { logger } from '../utils/logger';
import { downloadBaseOsu } from '../api/endpoints';
import { difficultyBaseOsuVersionAad } from '../utils/crypto';
import { parseOsuFile, withMetadataVersion } from '../utils/osuParser';
import { composeOsuFilename } from '../utils/osuFilename';
import type { MapsetRole, Post, Section } from '../api/endpoints';
import type { DecryptedSection } from '../components/SectionList';
import type { DecryptedPost } from '../types';

/** Stable empty array reference to avoid new-array churn in deps. */
const EMPTY_SECTIONS: Section[] = [];

export default function MapsetPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const mapsetId = id ?? '';
  const { data: mapset, isLoading: mapsetLoading, isError: mapsetError } = useMapset(mapsetId);
  const { data: myMembership } = useMyMembership(mapsetId);
  const { data: members } = useMembers(mapsetId, !!myMembership);
  const membersById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof members>[number]>();
    for (const m of members ?? []) map.set(m.user_id, m);
    return map;
  }, [members]);
  const { data: difficulties, isLoading: difficultiesLoading } = useDifficulties(mapsetId);
  const [selectedDifficultyId, setSelectedDifficultyId] = useState<string | null>(null);
  const { data: difficultyDetail, isLoading: detailLoading } = useDifficultyDetail(selectedDifficultyId);
  const { isUnlocked, getKey } = useEncryption();
  const { user } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const unlocked = isUnlocked(mapsetId);

  const createPostMutation = useCreatePost(selectedDifficultyId ?? '');
  const updatePostMutation = useUpdatePost(selectedDifficultyId ?? '');
  const deletePostMutation = useDeletePost(selectedDifficultyId ?? '');
  const deleteSectionMutation = useDeleteSection(selectedDifficultyId ?? '');
  const deleteDifficultyMutation = useDeleteDifficulty(mapsetId);

  const [showCreateDifficulty, setShowCreateDifficulty] = useState(false);
  const [showRenameDifficulty, setShowRenameDifficulty] = useState(false);
  const [showDeleteDifficultyConfirm, setShowDeleteDifficultyConfirm] = useState(false);
  const [showCreateSection, setShowCreateSection] = useState(false);
  const [showEditSection, setShowEditSection] = useState(false);
  const [showBaseHistory, setShowBaseHistory] = useState(false);
  const [showManageMembers, setShowManageMembers] = useState(false);
  const [difficultyNames, setDifficultyNames] = useState<Record<string, string>>({});
  const [editingSection, setEditingSection] = useState<DecryptedSection | null>(null);
  const [decryptedSections, setDecryptedSections] = useState<DecryptedSection[]>([]);
  const [decryptedDescription, setDecryptedDescription] = useState<string | null>(null);
  const [songLengthMs, setSongLengthMs] = useState<number | null>(null);
  const [decryptedPosts, setDecryptedPosts] = useState<DecryptedPost[]>([]);
  const [replyingTo, setReplyingTo] = useState<Post | null>(null);
  const [editingPost, setEditingPost] = useState<Post | null>(null);
  const [editingPostBody, setEditingPostBody] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showAllPosts, setShowAllPosts] = useState(false);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  // Owner-only role emulation: lets the owner preview the page as a mapper or
  // modder. Stored in component state — resets when leaving the page. Only the
  // owner's UI is affected; nothing is sent to the server.
  const [emulatedRole, setEmulatedRole] = useState<MapsetRole | null>(null);

  const actualRole = myMembership?.role ?? null;
  const actualIsOwner = actualRole === 'owner';
  const effectiveRole = actualIsOwner && emulatedRole ? emulatedRole : actualRole;
  const isOwner = effectiveRole === 'owner';
  const canEditStructure = isOwner || effectiveRole === 'mapper';

  // If the user loses ownership mid-session (e.g. transferred it to another
  // member), drop any active preview so it can't silently reactivate on a
  // future re-promotion.
  useEffect(() => {
    if (!actualIsOwner && emulatedRole !== null) {
      setEmulatedRole(null);
    }
  }, [actualIsOwner, emulatedRole]);

  useEffect(() => {
    if (difficulties && difficulties.length > 0 && selectedDifficultyId === null) {
      setSelectedDifficultyId(difficulties[0].id);
    }
  }, [difficulties, selectedDifficultyId]);

  // Clear transient forum states when switching difficulties
  useEffect(() => {
    setReplyingTo(null);
    setEditingPost(null);
    setShowCreateForm(false);
    setEditingPostBody('');
    setShowAllPosts(false);
    setSelectedSectionId(null);
  }, [selectedDifficultyId]);

  useEffect(() => {
    if (!unlocked || !mapset) {
      setDecryptedDescription(null);
      setSongLengthMs(null);
      return;
    }

    let cancelled = false;

    const m = mapset!;
    async function decryptMetadata() {
      try {
        const key = await getKey(mapsetId);
        if (!key || cancelled) return;

        const results = await Promise.allSettled([
          m.encrypted_description
            ? decrypt(key, m.encrypted_description, mapsetFieldAad(mapsetId))
            : Promise.resolve(null),
          decrypt(key, m.encrypted_song_length_ms, mapsetFieldAad(mapsetId)),
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

  // Decrypt sections whenever difficulty detail changes
  useEffect(() => {
    if (!unlocked || !difficultyDetail?.sections) {
      setDecryptedSections([]);
      return;
    }

    let cancelled = false;

    const ddSections = difficultyDetail!.sections;
    async function decryptSections() {
      try {
        const key = await getKey(mapsetId);
        if (!key || cancelled) return;

        const results: DecryptedSection[] = [];
        await Promise.all(
          ddSections.map(async (s) => {
            try {
              const aad = sectionFieldAad(s.id, mapsetId);
              // start_time_ms is intentionally not decrypted: section start
              // times are derived below from the running total of end times
              // so the timeline stays contiguous when end times are edited.
              const [name, endRaw, sortRaw] = await Promise.all([
                decrypt(key, s.encrypted_name, aad),
                decrypt(key, s.encrypted_end_time_ms, aad),
                decrypt(key, s.encrypted_sort_order, aad),
              ]);
              results.push({
                id: s.id,
                name,
                startTimeMs: 0,
                endTimeMs: decodeJsonEnvelope(endRaw),
                sortOrder: decodeJsonEnvelope(sortRaw),
              });
            } catch (_err) {
              logger.warn(`Failed to decrypt section ${s.id}:`, _err);
            }
          }),
        );

        if (!cancelled) {
          // Sort by the legacy sortOrder so we can derive contiguous start times.
          results.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));

          // Derive start times locally: first section starts at 0, every
          // subsequent section starts where the previous one ended.  This
          // guarantees the timeline stays contiguous even when a user edits
          // a section's end time — the next section shifts automatically.
          let runningStart = 0;
          const derived = results.map((s) => {
            const section = { ...s, startTimeMs: runningStart };
            runningStart = s.endTimeMs;
            return section;
          });

          setDecryptedSections(derived);
        }
      } catch (err) {
        logger.warn('Failed to decrypt sections:', err);
      }
    }

    decryptSections();
    return () => { cancelled = true; };
  }, [unlocked, difficultyDetail, mapsetId, getKey]);

  // Decrypt posts whenever the difficulty detail changes
  useEffect(() => {
    if (!unlocked || !difficultyDetail?.posts) {
      setDecryptedPosts([]);
      return;
    }

    let cancelled = false;

    const ddPosts = difficultyDetail!.posts;
    async function decryptPosts() {
      try {
        const key = await getKey(mapsetId);
        if (!key || cancelled) return;

        const results: DecryptedPost[] = await Promise.all(
          ddPosts.map(async (post): Promise<DecryptedPost> => {
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

  // Build reply trees for global posts view
  const globalPostTree = useMemo(() => {
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

  function renderGlobalPostNode(post: DecryptedPost, depth: number): JSX.Element | null {
    const MAX_REPLY_DEPTH = 10;
    if (depth > MAX_REPLY_DEPTH) return null;
    const replies = globalPostTree.replyMap.get(post.id) ?? [];
    const isReplyingToThis = replyingTo?.id === post.id;
    const isEditingThis = editingPost?.id === post.id;
    return (
      <div key={post.id} className={depth > 0 ? 'mt-2 ml-8 border-l-2 border-gray-700 pl-4' : ''}>
        <PostCard
          post={post}
          mapsetId={mapsetId}
          currentUserId={user?.id ?? ''}
          isOwner={isOwner}
          decryptedBody={post.decryptedBody}
          author={membersById.get(post.author_id) ?? null}
          showReplyButton={depth === 0}
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

        {isReplyingToThis && (
          <div className={depth === 0 ? 'mt-2 ml-8 border-l-2 border-gray-700 pl-4' : 'mt-2'}>
            <CreatePostForm
              mapsetId={mapsetId}
              difficultyId={selectedDifficultyId ?? ''}
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
              difficultyId={selectedDifficultyId ?? ''}
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

        {replies.map((reply) => renderGlobalPostNode(reply, depth + 1))}
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
    try {
      await createPostMutation.mutateAsync(payload);
      setReplyingTo(null);
      setShowCreateForm(false);
      showToast(t('mapsetPage.toastPostCreated'), 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('mapsetPage.toastFailedCreatePost'), 'error');
      // Re-throw so CreatePostForm can keep its draft state on failure.
      throw err;
    }
  }

  async function handleUpdatePost(payload: {
    id: string;
    tag: Post['tag'];
    encrypted_body: string;
    parent_id?: string | null;
  }) {
    try {
      await updatePostMutation.mutateAsync({ postId: payload.id, payload: { encrypted_body: payload.encrypted_body } });
      setEditingPost(null);
      setEditingPostBody('');
      showToast(t('mapsetPage.toastPostUpdated'), 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('mapsetPage.toastFailedUpdatePost'), 'error');
      // Re-throw so CreatePostForm can keep its draft state on failure.
      throw err;
    }
  }

  async function handleDeletePost(postId: string) {
    if (!confirm(t('mapsetPage.confirmDeletePost'))) return;
    try {
      await deletePostMutation.mutateAsync(postId);
      showToast(t('mapsetPage.toastPostDeleted'), 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('mapsetPage.toastFailedDeletePost'), 'error');
    }
  }

  async function handleDeleteSection(section: DecryptedSection) {
    try {
      await deleteSectionMutation.mutateAsync(section.id);
      setSelectedSectionId((current) => (current === section.id ? null : current));
      showToast(t('mapsetPage.toastSectionDeleted'), 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('mapsetPage.toastFailedDeleteSection'), 'error');
    }
  }

  async function handleDeleteDifficulty() {
    try {
      await deleteDifficultyMutation.mutateAsync(selectedDifficultyId);
      setSelectedDifficultyId(null);
      setShowDeleteDifficultyConfirm(false);
      showToast(t('mapsetPage.toastDifficultyDeleted'), 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('mapsetPage.toastFailedDeleteDifficulty'), 'error');
    }
  }

  async function handleDownloadBase() {
    if (!unlocked || !selectedDifficultyId) return;
    try {
      const key = await getKey(mapsetId);
      if (!key) return;
      const resp = await downloadBaseOsu(selectedDifficultyId);
      const plaintext = await decrypt(key, resp.encrypted_content, difficultyBaseOsuVersionAad(resp.id, mapsetId));
      // Rewrite [Metadata] Version to "Base_version_<N>" so the editor and
      // filename match. resp.version may be undefined on older payloads.
      const diffName = `Base_version_${resp.version ?? 0}`;
      const { content: finalContent, metadata } = withMetadataVersion(
        parseOsuFile(plaintext),
        diffName,
      );
      const filename = composeOsuFilename({
        artist: metadata.artist,
        title: metadata.title,
        mapsetTitle: mapset!.title,
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
      logger.warn('Failed to download base:', err);
    }
  }

  if (!id) return null;
  if (mapsetLoading) return <div className="min-h-screen bg-gray-900 text-white p-8">{t('mapsetPage.loading')}</div>;
  if (mapsetError || !mapset) {
    return <div className="min-h-screen bg-gray-900 text-white p-8 text-red-400">{t('mapsetPage.notFound')}</div>;
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

  const sections = difficultyDetail?.sections ?? EMPTY_SECTIONS;
  const selectedSection = decryptedSections.find((s) => s.id === selectedSectionId) ?? null;

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="inline-flex items-center gap-1.5 text-sm text-gray-300 hover:text-white transition-colors"
          >
            <span aria-hidden="true">←</span> {t('mapsetPage.back')}
          </button>
          <LanguageSwitcher />
        </div>
        {actualIsOwner && emulatedRole && (
          <div
            role="status"
            className="mb-4 bg-yellow-900/40 border border-yellow-700 rounded p-3 flex items-center justify-between gap-3"
          >
            <p className="text-sm text-yellow-200">
              {t('mapsetPage.previewingPrefix')}<strong>{emulatedRole}</strong>{t('mapsetPage.previewingSuffix')}
            </p>
            <button
              type="button"
              onClick={() => setEmulatedRole(null)}
              className="shrink-0 px-3 py-1 bg-yellow-700 hover:bg-yellow-600 text-white text-xs font-medium rounded"
            >
              {t('mapsetPage.exitPreview')}
            </button>
          </div>
        )}
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-blue-400">{mapset.title}</h1>
          {decryptedDescription && (
            <p className="text-gray-300 mt-2">{decryptedDescription}</p>
          )}
          {songLengthMs !== null && (
            <p className="text-sm text-gray-400 mt-1">{formatDuration(songLengthMs)}</p>
          )}
          <div className="flex items-center gap-3 mt-3">
            <button
              type="button"
              onClick={handleDownloadBase}
              disabled={!selectedDifficultyId}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 text-white text-sm font-medium rounded transition-colors"
            >
              {t('mapsetPage.downloadBase')}
            </button>
            <MergedDownloadButton
              difficultyId={selectedDifficultyId ?? ''}
              mapsetId={mapsetId}
              mapsetTitle={mapset.title}
              sections={sections}
              difficultyName={selectedDifficultyId ? difficultyNames[selectedDifficultyId] ?? null : null}
            />
            <button
              type="button"
              onClick={() => setShowBaseHistory(true)}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
            >
              {t('mapsetPage.baseHistory')}
            </button>
            {myMembership && (
              <button
                type="button"
                onClick={() => setShowManageMembers(true)}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
              >
                {actualIsOwner ? t('mapsetPage.manageMembers') : t('mapsetPage.viewMembers')}
              </button>
            )}
          </div>
        </div>

        {/* Difficulties */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-200">{t('mapsetPage.difficultiesHeading')}</h2>
          {canEditStructure && (
            <button
              type="button"
              onClick={() => setShowCreateDifficulty(true)}
              className="px-3 py-1.5 bg-pink-600 hover:bg-pink-500 text-white text-sm font-medium rounded transition-colors"
            >
              {t('mapsetPage.addDifficulty')}
            </button>
          )}
        </div>

        {difficultiesLoading && <p className="text-gray-400">{t('mapsetPage.loadingDifficulties')}</p>}

        {difficulties && difficulties.length > 0 && (
          <div className="mb-6">
            <DifficultyTabs
              difficulties={difficulties}
              selectedId={selectedDifficultyId}
              onSelect={setSelectedDifficultyId}
              mapsetId={mapsetId}
              onDecrypted={setDifficultyNames}
            />
          </div>
        )}

        {difficulties && difficulties.length === 0 && !difficultiesLoading && (
          <p className="text-gray-400 italic mb-6">{t('mapsetPage.noDifficulties')}</p>
        )}

        {selectedDifficultyId && (
          <div className="space-y-6">
            {/* Timeline */}
            {songLengthMs !== null && decryptedSections.length > 0 && (
              <Timeline
                sections={decryptedSections}
                posts={decryptedPosts}
                songLengthMs={songLengthMs}
                selectedSectionId={selectedSectionId}
                onSelectSection={(sectionId) => {
                  if (showAllPosts) {
                    // Switch from All Posts to Section View
                    setShowAllPosts(false);
                    setSelectedSectionId(sectionId);
                  } else if (selectedSectionId === sectionId) {
                    // Clicking already-selected section toggles to All Posts
                    setShowAllPosts(true);
                    setSelectedSectionId(null);
                  } else {
                    // Select a different section
                    setSelectedSectionId(sectionId);
                  }
                }}
              />
            )}

            {/* View toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {canEditStructure && (
                  <button
                    type="button"
                    onClick={() => setShowCreateSection(true)}
                    className="px-3 py-1.5 bg-pink-600 hover:bg-pink-500 text-white text-sm font-medium rounded transition-colors"
                  >
                    {t('mapsetPage.addSection')}
                  </button>
                )}
                {canEditStructure && selectedDifficultyId && (
                  <ImportBookmarksButton
                    difficultyId={selectedDifficultyId}
                    mapsetId={mapsetId}
                    existingSections={decryptedSections}
                    songLengthMs={songLengthMs}
                    onSuccess={(count, prepopulated) =>
                      showToast(
                        prepopulated
                          ? t('mapsetPage.toastImported', { count })
                          : t('mapsetPage.toastImportedNoPrefill', { count }),
                        'success',
                      )
                    }
                    onError={(msg) => showToast(msg, 'error')}
                  />
                )}
                {canEditStructure && selectedDifficultyId && difficultyNames[selectedDifficultyId] && (
                  <button
                    type="button"
                    onClick={() => setShowRenameDifficulty(true)}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
                  >
                    {t('mapsetPage.renameDifficulty')}
                  </button>
                )}
                {isOwner && selectedDifficultyId && difficultyNames[selectedDifficultyId] && (
                  <button
                    type="button"
                    onClick={() => setShowDeleteDifficultyConfirm(true)}
                    className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-sm font-medium rounded transition-colors"
                  >
                    {t('mapsetPage.deleteDifficulty')}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowAllPosts(false);
                    setSelectedSectionId(null);
                  }}
                  className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                    !showAllPosts
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {t('mapsetPage.sectionView')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAllPosts(true);
                    setSelectedSectionId(null);
                  }}
                  className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                    showAllPosts
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {t('mapsetPage.showAllPosts')}
                </button>
              </div>
            </div>

            {/* Content */}
            {!showAllPosts && selectedSection && (
              <SectionDetailPanel
                section={selectedSection}
                isLastSection={(() => {
                  const sorted = [...decryptedSections].sort(
                    (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
                  );
                  return sorted[sorted.length - 1]?.id === selectedSection.id;
                })()}
                posts={decryptedPosts}
                mapsetId={mapsetId}
                mapsetTitle={mapset.title}
                difficultyId={selectedDifficultyId}
                currentUserId={user?.id ?? ''}
                isOwner={isOwner}
                role={effectiveRole}
                canEditStructure={canEditStructure}
                membersById={membersById}
                onCreatePost={handleCreatePost}
                onUpdatePost={handleUpdatePost}
                onDeletePost={handleDeletePost}
                onEditSection={(s) => {
                  setEditingSection(s);
                  setShowEditSection(true);
                }}
                onDeleteSection={handleDeleteSection}
              />
            )}

            {!showAllPosts && !selectedSection && decryptedSections.length > 0 && (
              <p className="text-gray-400 italic">{t('mapsetPage.selectSection')}</p>
            )}

            {!showAllPosts && decryptedSections.length === 0 && !detailLoading && (
              <p className="text-gray-400 italic">{t('mapsetPage.noSectionsYet')}</p>
            )}

            {showAllPosts && (
              <div className="space-y-4">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-gray-200">{t('mapsetPage.allPostsHeading')}</h2>
                  <button
                    type="button"
                    onClick={() => {
                      setReplyingTo(null);
                      setEditingPost(null);
                      setShowCreateForm((prev) => !prev);
                    }}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors"
                  >
                    {showCreateForm ? t('mapsetPage.hideForm') : t('mapsetPage.newPost')}
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

                {detailLoading && <p className="text-gray-400">{t('mapsetPage.loadingPosts')}</p>}

                <div className="space-y-4">
                  {globalPostTree.topLevel.map((post) => renderGlobalPostNode(post, 0))}
                </div>

                {decryptedPosts.length === 0 && !detailLoading && (
                  <p className="text-gray-400 italic">{t('mapsetPage.noPostsYet')}</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {showCreateDifficulty && (
        <CreateDifficultyModal
          mapsetId={mapsetId}
          songLengthMs={songLengthMs}
          onSuccess={(newDifficultyId) => {
            setShowCreateDifficulty(false);
            setSelectedDifficultyId(newDifficultyId);
          }}
          onCancel={() => setShowCreateDifficulty(false)}
        />
      )}

      {showCreateSection && selectedDifficultyId && (
        <CreateSectionModal
          difficultyId={selectedDifficultyId}
          mapsetId={mapsetId}
          previousSections={decryptedSections}
          songLengthMs={songLengthMs}
          onSuccess={() => setShowCreateSection(false)}
          onCancel={() => setShowCreateSection(false)}
        />
      )}

      {showEditSection && editingSection && selectedDifficultyId && (() => {
        const sortedForEdit = [...decryptedSections].sort(
          (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
        );
        const idx = sortedForEdit.findIndex((s) => s.id === editingSection.id);
        const next = idx >= 0 ? sortedForEdit[idx + 1] : undefined;
        return (
        <EditSectionModal
          difficultyId={selectedDifficultyId}
          mapsetId={mapsetId}
          sectionId={editingSection.id}
          initialName={editingSection.name}
          initialStartTimeMs={editingSection.startTimeMs}
          initialEndTimeMs={editingSection.endTimeMs}
          nextSectionEndTimeMs={next?.endTimeMs ?? null}
          songLengthMs={songLengthMs}
          onSuccess={() => {
            setShowEditSection(false);
            setEditingSection(null);
          }}
          onCancel={() => {
            setShowEditSection(false);
            setEditingSection(null);
          }}
        />
        );
      })()}

      {showBaseHistory && selectedDifficultyId && (
        <BaseVersionHistory
          difficultyId={selectedDifficultyId}
          onClose={() => setShowBaseHistory(false)}
        />
      )}

      {showRenameDifficulty && selectedDifficultyId && difficultyNames[selectedDifficultyId] && (
        <RenameDifficultyModal
          mapsetId={mapsetId}
          difficultyId={selectedDifficultyId}
          currentName={difficultyNames[selectedDifficultyId]}
          onSuccess={() => setShowRenameDifficulty(false)}
          onCancel={() => setShowRenameDifficulty(false)}
        />
      )}

      {showDeleteDifficultyConfirm && selectedDifficultyId && difficultyNames[selectedDifficultyId] && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-difficulty-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        >
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-full max-w-sm shadow-xl">
            <h2 id="delete-difficulty-modal-title" className="text-lg font-bold text-white mb-3">
              {t('mapsetPage.deleteDifficultyTitle')}
            </h2>
            <p className="text-sm text-gray-300 mb-5">
              {t('mapsetPage.deleteDifficultyBodyPrefix')}
              <strong className="text-white">
                {difficultyNames[selectedDifficultyId]}
              </strong>
              {t('mapsetPage.deleteDifficultyBodySuffix')}
              <span className="text-red-400">{t('mapsetPage.deleteUndoneWarning')}</span>
            </p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setShowDeleteDifficultyConfirm(false)}
                disabled={deleteDifficultyMutation.isPending}
                className="px-4 py-2 text-gray-300 hover:text-white transition-colors disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleDeleteDifficulty}
                disabled={deleteDifficultyMutation.isPending}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded transition-colors"
              >
                {deleteDifficultyMutation.isPending ? t('common.deleting') : t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showManageMembers && (
        <ManageMembersModal
          mapsetId={mapsetId}
          currentUserId={user?.id ?? ''}
          isOwner={actualIsOwner}
          emulatedRole={emulatedRole}
          onEmulateRole={setEmulatedRole}
          onClose={() => setShowManageMembers(false)}
        />
      )}
    </div>
  );
}
