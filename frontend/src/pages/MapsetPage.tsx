import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import BaseVersionHistory from '../components/BaseVersionHistory';
import CreateDifficultyModal from '../components/CreateDifficultyModal';
import CreatePostForm from '../components/CreatePostForm';
import CreateSectionModal from '../components/CreateSectionModal';
import DifficultyTabs from '../components/DifficultyTabs';
import EditSectionModal from '../components/EditSectionModal';
import SplitSectionModal from '../components/SplitSectionModal';
import ImportBookmarksButton from '../components/ImportBookmarksButton';
import TopBar from '../components/TopBar';
import ManageMembersModal from '../components/ManageMembersModal';
import MergedDownloadButton from '../components/MergedDownloadButton';
import PassphraseModal from '../components/PassphraseModal';
import PendingDifficultyList from '../components/PendingDifficultyList';
import PostCard from '../components/PostCard';
import ResolveEvent from '../components/ResolveEvent';
import RenameDifficultyModal from '../components/RenameDifficultyModal';
import SectionDetailPanel from '../components/SectionDetailPanel';
import Timeline from '../components/Timeline';
import { useAuth } from '../hooks/useAuth';
import { useEncryption } from '../contexts/EncryptionContext';
import { useToast } from '../contexts/ToastContext';
import {
  useAssignSection,
  useCreatePost,
  useCreateSection,
  useDeleteDifficulty,
  useDeletePost,
  useDeleteSection,
  useDifficultyDetail,
  useDifficulties,
  useRestoreDifficulty,
  useUpdatePost,
  useUpdateSection,
} from '../hooks/useDifficulty';
import { useMapset, useMembers, useMyMembership } from '../hooks/useMapset';
import { decrypt, encrypt, decodeJsonEnvelope, mapsetFieldAad, postFieldAad, sectionFieldAad, sectionOsuVersionAad, difficultyBaseOsuVersionAad } from '../utils/crypto';
import { isAxiosError } from 'axios';
import { extractApiErrorMessage } from '../utils/errors';
import { extractFirstTimestamp } from '../utils/extractTimestamp';
import { logger } from '../utils/logger';
import { downloadBaseOsu, downloadSectionOsu, fetchDifficultyDetail } from '../api/endpoints';
import { parseOsuFile, withMetadataVersion } from '../utils/osuParser';
import { composeOsuFilename } from '../utils/osuFilename';
import { mergeOsu } from '../utils/osuMerge';
import { redistributeForDelete, redistributeForMerge, redistributeForShorten, hasSectionOsu } from '../utils/sectionRedistribute';
import { findNextSection, sortSections } from '../utils/sectionOrder';
import { deriveResolvedRootIds, canBeResolved, isStatusReply } from '../utils/resolveUtils';
import { compareRootPostOrder, compareReplyOrder } from '../utils/postSort';
import type { MapsetRole, Post, Section } from '../api/endpoints';
import type { DecryptedSection } from '../components/SectionList';
import type { DecryptedPost } from '../types';

/** Stable empty array reference to avoid new-array churn in deps. */
const EMPTY_SECTIONS: Section[] = [];

export default function MapsetPage() {
  const { t, i18n } = useTranslation();
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
  const [showPendingDifficulties, setShowPendingDifficulties] = useState(false);
  const { data: difficulties, isLoading: difficultiesLoading } = useDifficulties(mapsetId, {
    includePending: showPendingDifficulties,
  });
  const [selectedDifficultyId, setSelectedDifficultyId] = useState<string | null>(null);
  const { data: difficultyDetail, isLoading: detailLoading } = useDifficultyDetail(selectedDifficultyId);
  const { isUnlocked, getKey } = useEncryption();
  const { user } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const unlocked = isUnlocked(mapsetId);

  const createPostMutation = useCreatePost(selectedDifficultyId ?? '');
  const updatePostMutation = useUpdatePost(selectedDifficultyId ?? '');
  const deletePostMutation = useDeletePost(selectedDifficultyId ?? '');
  const deleteSectionMutation = useDeleteSection(selectedDifficultyId ?? '');
  const createSectionMutation = useCreateSection(selectedDifficultyId ?? '');
  const updateSectionMutation = useUpdateSection(selectedDifficultyId ?? '');
  const assignSectionMutation = useAssignSection(selectedDifficultyId ?? '');
  const deleteDifficultyMutation = useDeleteDifficulty(mapsetId);
  const restoreDifficultyMutation = useRestoreDifficulty(mapsetId);

  const [downloadingPendingId, setDownloadingPendingId] = useState<string | null>(null);
  const [showCreateDifficulty, setShowCreateDifficulty] = useState(false);
  const [showRenameDifficulty, setShowRenameDifficulty] = useState(false);
  const [showDeleteDifficultyConfirm, setShowDeleteDifficultyConfirm] = useState(false);
  const [showCreateSection, setShowCreateSection] = useState(false);
  const [showEditSection, setShowEditSection] = useState(false);
  const [showSplitSection, setShowSplitSection] = useState(false);
  const [splittingSection, setSplittingSection] = useState<DecryptedSection | null>(null);
  const [splitSubmitting, setSplitSubmitting] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [showBaseHistory, setShowBaseHistory] = useState(false);
  const [showManageMembers, setShowManageMembers] = useState(false);
  const [ghostBannerDismissed, setGhostBannerDismissed] = useState(false);
  const [difficultyNames, setDifficultyNames] = useState<Record<string, string>>({});
  const [editingSection, setEditingSection] = useState<DecryptedSection | null>(null);
  const [decryptedSections, setDecryptedSections] = useState<DecryptedSection[]>([]);
  const [sectionHitObjectMap, setSectionHitObjectMap] = useState<Map<string, boolean>>(new Map());
  // Cache keyed by "sectionId:startMs:endMs" so a range edit forces a rescan for that
  // section while sibling sections whose range is unchanged are skipped.
  const hitObjectCacheRef = useRef<Map<string, boolean>>(new Map());
  const [decryptedDescription, setDecryptedDescription] = useState<string | null>(null);
  const [songLengthMs, setSongLengthMs] = useState<number | null>(null);
  const [decryptedPosts, setDecryptedPosts] = useState<DecryptedPost[]>([]);
  const [replyingTo, setReplyingTo] = useState<Post | null>(null);
  const [editingPost, setEditingPost] = useState<Post | null>(null);
  const [editingPostBody, setEditingPostBody] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showAllPosts, setShowAllPosts] = useState(true);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  // Owner-only role emulation: lets the owner preview the page as a mapper,
  // modder, or ghost member. Stored in component state — resets when leaving
  // the page. Only the owner's UI is affected; nothing is sent to the server.
  const [emulatedRole, setEmulatedRole] = useState<MapsetRole | null>(null);
  const [emulateGhost, setEmulateGhost] = useState(false);
  const viewToggleRowRef = useRef<HTMLDivElement>(null);
  const leftGroupRef = useRef<HTMLDivElement>(null);
  const rightGroupRef = useRef<HTMLDivElement>(null);
  // Tracks the stable wrap state for hysteresis — updated inside checkAll, not in render.
  const isWrappedRef = useRef(false);
  const [leftGroupWrapped, setLeftGroupWrapped] = useState(false);
  const [rightGroupWrapped, setRightGroupWrapped] = useState(false);

  const realIsGhost = !!(myMembership?.kicked_at);
  const isGhost = realIsGhost || emulateGhost;
  const actualRole = myMembership?.role ?? null;
  const actualIsOwner = !realIsGhost && actualRole === 'owner';
  const effectiveRole = actualIsOwner && emulatedRole && !emulateGhost ? emulatedRole : actualRole;
  const isOwner = !isGhost && effectiveRole === 'owner';
  const canEditStructure = !isGhost && (isOwner || effectiveRole === 'mapper');

  // If the user loses ownership mid-session (e.g. transferred it to another
  // member), drop any active preview so it can't silently reactivate on a
  // future re-promotion.
  useEffect(() => {
    if (!actualIsOwner) {
      if (emulatedRole !== null) setEmulatedRole(null);
      if (emulateGhost) setEmulateGhost(false);
    }
  }, [actualIsOwner, emulatedRole, emulateGhost]);

  const { activeDifficulties, pendingDifficulties } = useMemo(() => {
    const active: NonNullable<typeof difficulties> = [];
    const pending: NonNullable<typeof difficulties> = [];
    for (const d of difficulties ?? []) {
      (d.delete_at ? pending : active).push(d);
    }
    return { activeDifficulties: active, pendingDifficulties: pending };
  }, [difficulties]);

  // Keep the selection pointing at a valid active difficulty. Handles three
  // cases in one pass: no selection yet → pick first; selected diff was
  // soft-deleted → pick first (or clear if none left); selection already valid → no-op.
  useEffect(() => {
    const isCurrentActive =
      selectedDifficultyId !== null &&
      activeDifficulties.some((d) => d.id === selectedDifficultyId);
    if (!isCurrentActive) {
      setSelectedDifficultyId(activeDifficulties[0]?.id ?? null);
    }
  }, [activeDifficulties, selectedDifficultyId]);

  // Clear transient forum states when switching difficulties
  useEffect(() => {
    setReplyingTo(null);
    setEditingPost(null);
    setShowCreateForm(false);
    setEditingPostBody('');
    setShowAllPosts(true);
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
                assignedTo: s.assigned_to,
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

  // Clear the hit-object map and its cache whenever the difficulty changes so
  // stale results from a previous difficulty never bleed through.
  useEffect(() => {
    hitObjectCacheRef.current = new Map();
    setSectionHitObjectMap(new Map());
  }, [selectedDifficultyId]);

  // Background scan: download + parse each section's .osu to check whether it
  // contains any hit objects within the section's own time range.
  // Cache key = "sectionId:startMs:endMs" — a range edit invalidates only that
  // section while siblings with unchanged ranges are skipped.
  useEffect(() => {
    if (!decryptedSections.length || !selectedDifficultyId || !unlocked) return;

    const makeKey = (s: DecryptedSection) => `${s.id}:${s.startTimeMs}:${s.endTimeMs}`;
    const sectionsToScan = decryptedSections.filter((s) => !hitObjectCacheRef.current.has(makeKey(s)));
    if (!sectionsToScan.length) return;

    let cancelled = false;

    async function scanHitObjects() {
      const key = await getKey(mapsetId);
      if (!key || cancelled) return;

      const updates = new Map<string, boolean>();
      const tasks = sectionsToScan.map((section) => async () => {
        try {
          const resp = await downloadSectionOsu(selectedDifficultyId!, section.id);
          const plaintext = await decrypt(key, resp.encrypted_content, sectionOsuVersionAad(resp.id, mapsetId));
          const parsed = parseOsuFile(plaintext);
          const hasInRange = parsed.hitObjects.some(
            (ho) => ho.time >= section.startTimeMs && ho.time < section.endTimeMs,
          );
          updates.set(section.id, hasInRange);
          hitObjectCacheRef.current.set(makeKey(section), hasInRange);
        } catch (err) {
          const is404 = isAxiosError(err) && err.response?.status === 404;
          updates.set(section.id, false);
          // Only cache 404 (no file uploaded). Transient failures are left
          // uncached so the section is retried on the next sections change.
          if (is404) hitObjectCacheRef.current.set(makeKey(section), false);
        }
      });

      const queue = [...tasks];
      const worker = async () => { while (queue.length > 0) await queue.shift()!(); };
      await Promise.all(Array.from({ length: Math.min(5, tasks.length) }, worker));

      if (!cancelled) setSectionHitObjectMap((prev) => {
        const next = new Map(prev);
        for (const [id, val] of updates) next.set(id, val);
        return next;
      });
    }

    scanHitObjects();
    return () => { cancelled = true; };
  }, [decryptedSections, selectedDifficultyId, unlocked, mapsetId, getKey]);

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
          setDecryptedPosts(results);
        }
      } catch (err) {
        logger.warn('Failed to decrypt posts:', err);
      }
    }

    decryptPosts();
    return () => { cancelled = true; };
  }, [unlocked, difficultyDetail, mapsetId, getKey]);

  useEffect(() => {
    if (!jumpTarget || !showAllPosts) return;
    const el = document.getElementById(`post-${jumpTarget}`);
    setJumpTarget(null);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('post-flash');
    void el.offsetWidth; // force reflow to restart animation
    el.classList.add('post-flash');
    setTimeout(() => el.classList.remove('post-flash'), 3000);
  }, [jumpTarget, showAllPosts]);

  // Detect when the two button groups together no longer fit side-by-side.
  // Clone each group's children into an off-screen probe (position:fixed, width:max-content)
  // to read unconstrained natural widths — no mutations to the real layout, no feedback loop.
  // useLayoutEffect avoids the first-paint flash: the correct layout is applied before the
  // browser paints. Gap is hardcoded to the row-mode value per group (left: gap-3=12px,
  // right: gap-2=8px) because getComputedStyle(el).gap would return the column-mode gap
  // when already wrapped, underestimating the natural row width.
  const selectedDifficultyName = selectedDifficultyId ? (difficultyNames[selectedDifficultyId] ?? null) : null;
  useLayoutEffect(() => {
    function measureNaturalRowWidth(el: HTMLDivElement, rowGapPx: number): number {
      if (!el.children.length) return 0;
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;display:flex;flex-direction:row;flex-wrap:nowrap;width:max-content;';
      probe.style.gap = `${rowGapPx}px`;
      Array.from(el.children).forEach(child => {
        const clone = child.cloneNode(true) as HTMLElement;
        clone.style.flexShrink = '0';
        probe.appendChild(clone);
      });
      document.body.appendChild(probe);
      const width = probe.offsetWidth;
      document.body.removeChild(probe);
      return width;
    }
    const checkAll = () => {
      const outerEl = viewToggleRowRef.current;
      const leftEl = leftGroupRef.current;
      const rightEl = rightGroupRef.current;
      if (!outerEl || !leftEl || !rightEl) return;
      const leftNatural = measureNaturalRowWidth(leftEl, 12);  // gap-3 in row mode
      const rightNatural = measureNaturalRowWidth(rightEl, 8); // gap-2 in row mode
      // Hysteresis: wider dead-zone to exit column mode than to enter it,
      // preventing oscillation right at the threshold during resize.
      const buffer = isWrappedRef.current ? 48 : 16;
      const needsWrap = leftNatural + rightNatural + buffer > outerEl.clientWidth;
      isWrappedRef.current = needsWrap;
      setLeftGroupWrapped(needsWrap);
      setRightGroupWrapped(needsWrap);
    };
    checkAll();
    const ro = new ResizeObserver(checkAll);
    if (viewToggleRowRef.current) ro.observe(viewToggleRowRef.current);
    return () => ro.disconnect();
  }, [canEditStructure, isOwner, selectedDifficultyId, selectedDifficultyName, i18n.language]);

  // Build reply trees for global posts view
  const globalPostTree = useMemo(() => {
    const topLevel: DecryptedPost[] = [];
    const replyMap = new Map<string, DecryptedPost[]>();

    for (const post of decryptedPosts) {
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
  }, [decryptedPosts]);

  const resolvedPostIds = useMemo(() => deriveResolvedRootIds(globalPostTree), [globalPostTree]);

  function renderGlobalPostNode(post: DecryptedPost, depth: number): JSX.Element | null {
    const MAX_REPLY_DEPTH = 10;
    if (depth > MAX_REPLY_DEPTH) return null;
    const replies = globalPostTree.replyMap.get(post.id) ?? [];
    const isReplyingToThis = replyingTo?.id === post.id;
    const isEditingThis = editingPost?.id === post.id;
    const isResolved = depth === 0 && resolvedPostIds.has(post.id);
    return (
      <div key={post.id} id={`post-${post.id}`} className={depth > 0 ? 'mt-2 ml-8 border-l-2 border-gray-700 pl-4' : ''}>
        <PostCard
          post={post}
          mapsetId={mapsetId}
          currentUserId={user?.id ?? ''}
          isOwner={isOwner}
          decryptedBody={post.decryptedBody}
          author={membersById.get(post.author_id) ?? null}
          showReplyButton={depth === 0}
          isResolved={isResolved}
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
              resolveAction={depth === 0 && canBeResolved(post.tag) ? (resolvedPostIds.has(post.id) ? 'reopen' : 'resolve') : undefined}
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

        {replies.map((reply) => {
          if (depth === 0 && isStatusReply(reply.tag)) {
            return (
              <div key={reply.id} className="mt-2 ml-8 border-l-2 border-gray-700 pl-4">
                <ResolveEvent
                  post={reply}
                  author={membersById.get(reply.author_id) ?? null}
                  currentUserId={user?.id ?? ''}
                  isOwner={isOwner}
                  onDelete={handleDeletePost}
                />
              </div>
            );
          }
          if (isStatusReply(reply.tag)) return null;
          return renderGlobalPostNode(reply, depth + 1);
        })}
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
    if (!selectedDifficultyId) return;
    const next = findNextSection(decryptedSections, section.id);
    try {
      if (!next) {
        // Final section: only allow deletion when there is no .osu blob to
        // lose. If a blob exists we have nowhere to move its hit objects, so
        // we block and suggest shortening instead.
        const hasBlob = await hasSectionOsu(selectedDifficultyId, section.id);
        if (hasBlob) {
          showToast(t('mapsetPage.toastCannotDeleteLastSection'), 'error');
          return;
        }
        // No blob → nothing to lose, proceed straight to delete.
      } else {
        // Require the encryption key. Without it redistributeForDelete cannot
        // run and we'd silently drop the deleted section's hit objects — the
        // exact data loss this flow exists to prevent. Surface "unlock first".
        const key = await getKey(mapsetId);
        if (!key) {
          showToast(t('mapsetPage.toastDeleteNeedsUnlock'), 'error');
          return;
        }
        await redistributeForDelete({
          difficultyId: selectedDifficultyId,
          mapsetId,
          deletedSectionId: section.id,
          nextSectionId: next.id,
          key,
        });
        queryClient.invalidateQueries({ queryKey: ['section-osu-versions', selectedDifficultyId, next.id] });
      }
      await deleteSectionMutation.mutateAsync(section.id);
      setSelectedSectionId((current) => (current === section.id ? null : current));
      showToast(t('mapsetPage.toastSectionDeleted'), 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('mapsetPage.toastFailedDeleteSection'), 'error');
    }
  }

  async function handleMergeSection(section: DecryptedSection) {
    if (!selectedDifficultyId) return;
    const next = findNextSection(decryptedSections, section.id);
    if (!next) return;

    const key = await getKey(mapsetId);
    if (!key) {
      showToast(t('mapsetPage.toastMergeNeedsUnlock'), 'error');
      return;
    }

    // Any assignment on `next` is silently lost when its row is deleted.
    // The confirm dialog already names both sections so the owner is aware.
    //
    // Step order: redistribute → update end_time → delete.
    // Alternative order (redistribute → delete → update) avoids the
    // "overlapping sections" failure mode but risks a coverage gap: if update
    // fails after delete, target's endTimeMs still points to the old boundary
    // so the time range [oldEnd, next.endTime] becomes uncovered and target's
    // moved hit objects in that range get clipped. The chosen order instead
    // risks a surviving orphaned `next` row when delete fails — recoverable
    // by a manual delete — while keeping the data intact in target.

    // Capture non-null values now so the inner function can reference them
    // safely — TypeScript control-flow narrowing doesn't carry into closures.
    const diffId = selectedDifficultyId;
    const nextId = next.id;

    function finishMergeSuccess() {
      queryClient.invalidateQueries({ queryKey: ['difficulty-detail', diffId] });
      queryClient.invalidateQueries({ queryKey: ['section-osu-versions', diffId, section.id] });
      setSelectedSectionId((current) => (current === nextId ? section.id : current));
      showToast(t('mapsetPage.toastSectionMerged'), 'success');
    }

    let mergeStep: 'redistribute' | 'update' | 'delete' = 'redistribute';
    try {
      await redistributeForMerge({
        difficultyId: diffId,
        mapsetId,
        targetSectionId: section.id,
        sourceSectionId: nextId,
        key,
      });

      mergeStep = 'update';
      const encryptedEnd = await encrypt(
        key,
        JSON.stringify({ v: 0, ms: next.endTimeMs }),
        sectionFieldAad(section.id, mapsetId),
      );
      await updateSectionMutation.mutateAsync({
        sectionId: section.id,
        payload: { encrypted_end_time_ms: encryptedEnd },
      });

      mergeStep = 'delete';
      await deleteSectionMutation.mutateAsync(nextId);

      finishMergeSuccess();
    } catch (err) {
      if (mergeStep !== 'redistribute') {
        // If the only failure was deleting `next` and it returned 404, the
        // section was already gone (concurrent delete). The redistribute and
        // end-time update both succeeded, so the state is consistent — treat
        // it as success rather than firing the misleading partial-failure toast.
        if (mergeStep === 'delete' && isAxiosError(err) && err.response?.status === 404) {
          finishMergeSuccess();
        } else {
          queryClient.invalidateQueries({ queryKey: ['difficulty-detail', diffId] });
          showToast(t('mapsetPage.toastMergePartialFailure'), 'error');
        }
      } else {
        showToast(extractApiErrorMessage(err, t('mapsetPage.toastFailedMergeSection')), 'error');
      }
    }
  }

  function handleOpenSplitSection(s: DecryptedSection) {
    setSplittingSection(s);
    setSplitError(null);
    setShowSplitSection(true);
  }

  async function handleSplitSection(
    section: DecryptedSection,
    { newSectionName, splitTimeMs }: { newSectionName: string; splitTimeMs: number },
  ) {
    if (!selectedDifficultyId) return;
    setSplitSubmitting(true);
    setSplitError(null);

    // Step order: create → redistribute → update.
    //
    // EditSectionModal uses the reverse (update first, then redistribute)
    // because for a pure shorten, "redistribute first then update fails"
    // would leave moved HOs in next's blob below next's eventual startTimeMs
    // — the clipper drops them with no retry signal (see EditSectionModal's
    // long comment). That logic does NOT apply to split: there's a `create`
    // step in between, and the new section already covers the moved range
    // by construction. The current order's worst failure is a visible
    // overlap with intact data; the reversed order's worst failure is
    // silent data loss from the merge clipper. Don't flip without an
    // atomic backend "create row + first .osu version" endpoint — see
    // memory: project_split_atomic_create_followup.
    let splitStep: 'create' | 'redistribute' | 'update' = 'create';
    try {
      const key = await getKey(mapsetId);
      if (!key) {
        setSplitError(t('splitSectionModal.errorKeyMissing'));
        setSplitSubmitting(false);
        return;
      }

      const newId = crypto.randomUUID();
      const next = findNextSection(decryptedSections, section.id);
      // JS doubles give ~53 bits of mantissa; repeated splits between the
      // same two sections halve the gap each time. After ~50 splits
      // (section.sortOrder + next.sortOrder) / 2 === section.sortOrder and
      // the id lexicographic tiebreaker silently takes over. Acceptable in
      // practice; a sort-order renumber would be the principled fix if it
      // ever becomes an issue.
      const newSortOrder = next
        ? (section.sortOrder + next.sortOrder) / 2
        : section.sortOrder + 1;

      const [encName, encStart, encEnd, encSort] = await Promise.all([
        encrypt(key, newSectionName, sectionFieldAad(newId, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: splitTimeMs }), sectionFieldAad(newId, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: section.endTimeMs }), sectionFieldAad(newId, mapsetId)),
        encrypt(key, JSON.stringify({ v: 0, ms: newSortOrder }), sectionFieldAad(newId, mapsetId)),
      ]);

      await createSectionMutation.mutateAsync({
        id: newId,
        encrypted_name: encName,
        encrypted_start_time_ms: encStart,
        encrypted_end_time_ms: encEnd,
        encrypted_sort_order: encSort,
      });

      splitStep = 'redistribute';
      await redistributeForShorten({
        difficultyId: selectedDifficultyId,
        mapsetId,
        sourceSectionId: section.id,
        nextSectionId: newId,
        newEndMs: splitTimeMs,
        key,
      });

      splitStep = 'update';
      const encryptedEnd = await encrypt(
        key,
        JSON.stringify({ v: 0, ms: splitTimeMs }),
        sectionFieldAad(section.id, mapsetId),
      );
      await updateSectionMutation.mutateAsync({
        sectionId: section.id,
        payload: { encrypted_end_time_ms: encryptedEnd },
      });

      queryClient.invalidateQueries({ queryKey: ['section-osu-versions', selectedDifficultyId, section.id] });
      queryClient.invalidateQueries({ queryKey: ['section-osu-versions', selectedDifficultyId, newId] });

      setShowSplitSection(false);
      setSplittingSection(null);
      showToast(t('mapsetPage.toastSectionSplit'), 'success');
    } catch (err) {
      if (splitStep !== 'create') {
        // The new section row was already created server-side (step 1 succeeded).
        // Keeping the modal open risks a second submit creating another orphaned
        // row. Close it, invalidate the section list so the orphan is visible
        // after the prompted refresh, and surface the inconsistency via toast.
        // What the user will see: an extra empty section (redistribute failure)
        // or two sections with overlapping ranges (update failure) — both are
        // recoverable by deleting the stray section or re-editing end times.
        queryClient.invalidateQueries({ queryKey: ['difficulty-detail', selectedDifficultyId!] });
        setShowSplitSection(false);
        setSplittingSection(null);
        showToast(t('mapsetPage.toastSplitPartialFailure'), 'error');
      } else {
        setSplitError(extractApiErrorMessage(err, t('mapsetPage.toastFailedSplitSection')));
      }
    } finally {
      setSplitSubmitting(false);
    }
  }

  async function handleAssignSection(sectionId: string, userId: string | null) {
    try {
      await assignSectionMutation.mutateAsync({ sectionId, userId });
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('mapsetPage.toastFailedAssignSection'), 'error');
    }
  }

  async function handleDeleteDifficulty() {
    if (!selectedDifficultyId) return;
    try {
      await deleteDifficultyMutation.mutateAsync(selectedDifficultyId);
      setSelectedDifficultyId(null);
      setShowDeleteDifficultyConfirm(false);
      showToast(t('mapsetPage.toastDifficultyDeleted'), 'success');
    } catch (err) {
      showToast(
        extractApiErrorMessage(err, t('mapsetPage.toastFailedDeleteDifficulty')),
        'error',
      );
    }
  }

  async function handleRestoreDifficulty(difficultyId: string) {
    try {
      await restoreDifficultyMutation.mutateAsync(difficultyId);
      showToast(t('mapsetPage.toastDifficultyRestored'), 'success');
    } catch (err) {
      showToast(
        extractApiErrorMessage(err, t('mapsetPage.toastFailedRestoreDifficulty')),
        'error',
      );
    }
  }

  async function handleDownloadPendingDifficulty(difficultyId: string, difficultyName: string) {
    if (!unlocked) return;
    setDownloadingPendingId(difficultyId);
    try {
      const key = await getKey(mapsetId);
      if (!key) return;

      const detail = await fetchDifficultyDetail(difficultyId);
      const baseResp = await downloadBaseOsu(difficultyId);
      const basePlaintext = await decrypt(
        key,
        baseResp.encrypted_content,
        difficultyBaseOsuVersionAad(baseResp.id, mapsetId),
      );

      const sectionInputs: { content: string; sortOrder: number; sectionId: string }[] = [];
      let skippedSections = 0;
      const sectionTasks = detail.sections.map((section) => async () => {
        try {
          const resp = await downloadSectionOsu(difficultyId, section.id);
          const plaintext = await decrypt(
            key,
            resp.encrypted_content,
            sectionOsuVersionAad(resp.id, mapsetId),
          );
          const sortOrderRaw = await decrypt(
            key,
            section.encrypted_sort_order,
            sectionFieldAad(section.id, mapsetId),
          );
          sectionInputs.push({ content: plaintext, sortOrder: decodeJsonEnvelope(sortOrderRaw), sectionId: section.id });
        } catch (err) {
          logger.warn(`Failed to fetch section ${section.id} for pending download:`, err);
          skippedSections++;
        }
      });
      const concurrencyQueue = [...sectionTasks];
      const worker = async () => { while (concurrencyQueue.length > 0) await concurrencyQueue.shift()!(); };
      await Promise.all(Array.from({ length: Math.min(5, sectionTasks.length) }, worker));

      const merged = mergeOsu(basePlaintext, sectionInputs);
      const diffLabel = `${difficultyName}_version_${baseResp.version ?? 0}`;
      const { content: finalContent, metadata } = withMetadataVersion(parseOsuFile(merged), diffLabel);
      const filename = composeOsuFilename({
        artist: metadata.artist,
        title: metadata.title,
        mapsetTitle: mapset?.title ?? '',
        diffName: diffLabel,
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

      if (skippedSections > 0) {
        showToast(
          t('mapsetPage.pendingDownloadSkippedSections', { count: skippedSections }),
          'warning',
        );
      }
    } catch (err) {
      logger.warn('Failed to download pending difficulty:', err);
      showToast(err instanceof Error ? err.message : t('mapsetPage.toastFailedDownloadPending'), 'error');
    } finally {
      setDownloadingPendingId(null);
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
        mapsetTitle: mapset?.title ?? '',
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
    <div className="min-h-screen bg-gray-900 text-white px-8 pb-8 pt-20">
      <TopBar
        left={
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="inline-flex items-center gap-1.5 text-sm text-gray-300 hover:text-white transition-colors"
          >
            <span aria-hidden="true">←</span> {t('mapsetPage.back')}
          </button>
        }
      />
      <div className="max-w-6xl mx-auto">
        {actualIsOwner && (emulatedRole || emulateGhost) && (
          <div
            role="status"
            className="mb-4 bg-yellow-900/40 border border-yellow-700 rounded p-3 flex items-center justify-between gap-3"
          >
            <p className="text-sm text-yellow-200">
              {emulateGhost
                ? t('mapsetPage.previewingGhost')
                : <>{t('mapsetPage.previewingPrefix')}<strong>{emulatedRole}</strong>{t('mapsetPage.previewingSuffix')}</>
              }
            </p>
            <button
              type="button"
              onClick={() => { setEmulatedRole(null); setEmulateGhost(false); }}
              className="shrink-0 px-3 py-1 bg-yellow-700 hover:bg-yellow-600 text-white text-xs font-medium rounded"
            >
              {t('mapsetPage.exitPreview')}
            </button>
          </div>
        )}
        {realIsGhost && !ghostBannerDismissed && myMembership?.kicked_at && (
          <div
            role="status"
            className="mb-4 bg-orange-900/40 border border-orange-700 rounded p-3 flex items-center justify-between gap-3"
          >
            <p className="text-sm text-orange-200">
              {t('mapsetPage.ghostBanner', {
                date: new Date(
                  new Date(myMembership.kicked_at).getTime() + 7 * 86_400_000,
                ).toLocaleDateString(),
              })}
            </p>
            <button
              type="button"
              onClick={() => setGhostBannerDismissed(true)}
              className="shrink-0 px-3 py-1 bg-orange-700 hover:bg-orange-600 text-white text-xs font-medium rounded"
            >
              {t('mapsetPage.ghostBannerDismiss')}
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
            {myMembership && !isGhost && (
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
        <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
          <h2 className="text-lg font-semibold text-gray-200">{t('mapsetPage.difficultiesHeading')}</h2>
          <div className="flex items-center gap-2">
            {isOwner && (
              <button
                type="button"
                onClick={() => setShowPendingDifficulties((v) => !v)}
                aria-pressed={showPendingDifficulties}
                className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                  showPendingDifficulties
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {showPendingDifficulties
                  ? t('mapsetPage.hidePendingDifficulties')
                  : t('mapsetPage.showPendingDifficulties')}
              </button>
            )}
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
        </div>

        {difficultiesLoading && <p className="text-gray-400">{t('mapsetPage.loadingDifficulties')}</p>}

        {activeDifficulties.length > 0 && (
          <div className="mb-6">
            <DifficultyTabs
              difficulties={activeDifficulties}
              selectedId={selectedDifficultyId}
              onSelect={setSelectedDifficultyId}
              mapsetId={mapsetId}
              onDecrypted={setDifficultyNames}
            />
          </div>
        )}

        {activeDifficulties.length === 0 && !difficultiesLoading && (
          <p className="text-gray-400 italic mb-6">{t('mapsetPage.noDifficulties')}</p>
        )}

        {isOwner && showPendingDifficulties && (
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-300 mb-2">
              {t('mapsetPage.pendingDifficultiesHeading')}
            </h3>
            <PendingDifficultyList
              difficulties={pendingDifficulties}
              mapsetId={mapsetId}
              onRestore={handleRestoreDifficulty}
              restoringId={
                restoreDifficultyMutation.isPending
                  ? (restoreDifficultyMutation.variables ?? null)
                  : null
              }
              onDownload={handleDownloadPendingDifficulty}
              downloadingId={downloadingPendingId}
            />
          </div>
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
                membersById={membersById}
                sectionHitObjectMap={sectionHitObjectMap}
                resolvedPostIds={resolvedPostIds}
                onJumpToPost={(postId) => {
                  setShowAllPosts(true);
                  setSelectedSectionId(null);
                  setJumpTarget(postId);
                }}
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
            <div ref={viewToggleRowRef} className="flex items-start justify-between">
              <div ref={leftGroupRef} data-testid="view-toggle-left" className={leftGroupWrapped ? 'flex flex-col items-start gap-2' : 'flex items-center gap-3'}>
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
              <div ref={rightGroupRef} data-testid="view-toggle-right" className={rightGroupWrapped ? 'flex flex-col items-end gap-2' : 'flex items-center gap-2'}>
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
                  const sorted = sortSections(decryptedSections);
                  return sorted[sorted.length - 1]?.id === selectedSection.id;
                })()}
                nextSection={findNextSection(decryptedSections, selectedSection.id)}
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
                onAssignSection={handleAssignSection}
                onEditSection={(s) => {
                  setEditingSection(s);
                  setShowEditSection(true);
                }}
                onDeleteSection={handleDeleteSection}
                onMergeSection={isOwner ? handleMergeSection : undefined}
                onSplitSection={isOwner ? handleOpenSplitSection : undefined}
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
                  {!isGhost && (
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
                  )}
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
        const next = findNextSection(decryptedSections, editingSection.id);
        return (
        <EditSectionModal
          difficultyId={selectedDifficultyId}
          mapsetId={mapsetId}
          sectionId={editingSection.id}
          initialName={editingSection.name}
          initialStartTimeMs={editingSection.startTimeMs}
          initialEndTimeMs={editingSection.endTimeMs}
          nextSectionId={next?.id ?? null}
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

      {showSplitSection && splittingSection && (
        <SplitSectionModal
          section={splittingSection}
          onSubmit={(params) => handleSplitSection(splittingSection, params)}
          onCancel={() => {
            setShowSplitSection(false);
            setSplittingSection(null);
            setSplitError(null);
          }}
          submitting={splitSubmitting}
          externalError={splitError}
        />
      )}

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
          emulateGhost={emulateGhost}
          onEmulateGhost={setEmulateGhost}
          onClose={() => setShowManageMembers(false)}
        />
      )}
    </div>
  );
}
