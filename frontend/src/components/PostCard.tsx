import { useEffect, useState } from 'react';
import type { Post, PostTag } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { decrypt, postFieldAad } from '../utils/crypto';
import { extractFirstTimestamp, findAllTimestamps, generateOsuLink, formatTimestamp } from '../utils/extractTimestamp';
import { logger } from '../utils/logger';

interface PostCardProps {
  post: Post;
  mapsetId: string;
  currentUserId: string;
  isOwner: boolean;
  /** When provided, decryption is skipped and this plaintext is used directly. */
  decryptedBody?: string | null;
  /** If false, the Reply button is hidden even when onReply is provided. */
  showReplyButton?: boolean;
  onReply?: (post: Post) => void;
  onEdit?: (post: Post) => void;
  onDelete?: (postId: string) => void;
}

const TAG_COLORS: Record<PostTag, string> = {
  general: 'bg-gray-500',
  suggestion: 'bg-blue-500',
  problem: 'bg-red-500',
  praise: 'bg-green-500',
};

const TAG_LABELS: Record<PostTag, string> = {
  general: 'General',
  suggestion: 'Suggestion',
  problem: 'Problem',
  praise: 'Praise',
};

function storageKey(userId: string, postId: string): string {
  return `post-collapsed:${userId}:${postId}`;
}

export default function PostCard({
  post,
  mapsetId,
  currentUserId,
  isOwner,
  decryptedBody: propDecryptedBody,
  showReplyButton = true,
  onReply,
  onEdit,
  onDelete,
}: PostCardProps) {
  const { isUnlocked, getKey } = useEncryption();
  const unlocked = isUnlocked(mapsetId);
  const [decryptedBody, setDecryptedBody] = useState<string | null>(propDecryptedBody ?? null);
  const [isCollapsed, setIsCollapsed] = useState(() => {
    try {
      return localStorage.getItem(storageKey(currentUserId, post.id)) === 'true';
    } catch {
      return false;
    }
  });
  const isAuthor = post.author_id === currentUserId;
  const canEdit = isAuthor;
  const canDelete = isAuthor || isOwner;

  useEffect(() => {
    if (propDecryptedBody !== undefined) {
      setDecryptedBody(propDecryptedBody);
      return;
    }
    if (!unlocked) {
      setDecryptedBody(null);
      return;
    }
    let cancelled = false;

    async function decryptBody() {
      try {
        const key = await getKey(mapsetId);
        if (!key || cancelled) return;
        const plaintext = await decrypt(key, post.encrypted_body, postFieldAad(post.id, mapsetId));
        if (!cancelled) setDecryptedBody(plaintext);
      } catch (err) {
        logger.warn(`Failed to decrypt post ${post.id}:`, err);
        if (!cancelled) setDecryptedBody(null);
      }
    }

    decryptBody();
    return () => { cancelled = true; };
  }, [unlocked, post, mapsetId, getKey, propDecryptedBody]);

  const toggleCollapse = () => {
    const next = !isCollapsed;
    setIsCollapsed(next);
    try {
      localStorage.setItem(storageKey(currentUserId, post.id), String(next));
    } catch {
      // ignore
    }
  };

  const primaryTimestamp = decryptedBody ? extractFirstTimestamp(decryptedBody) : null;

  function renderBody(text: string): React.ReactNode {
    const matches = findAllTimestamps(text);
    if (matches.length === 0) {
      return <p className="text-gray-200 whitespace-pre-wrap">{text}</p>;
    }

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;

    for (const match of matches) {
      if (match.index > lastIndex) {
        parts.push(
          <span key={`text-${lastIndex}`}>
            {text.slice(lastIndex, match.index)}
          </span>,
        );
      }
      const link = generateOsuLink(match.ms, match.combos);
      parts.push(
        <a
          key={`link-${match.index}`}
          href={link}
          className="text-blue-400 hover:text-blue-300 underline"
          onClick={(e) => {
            // Prevent the click from being intercepted by collapse handler
            e.stopPropagation();
          }}
        >
          {match.raw}
        </a>,
      );
      lastIndex = match.index + match.raw.length;
    }

    if (lastIndex < text.length) {
      parts.push(<span key={`text-end`}>{text.slice(lastIndex)}</span>);
    }

    return <p className="text-gray-200 whitespace-pre-wrap">{parts}</p>;
  }

  const authorLabel = isAuthor ? 'You' : `User ${post.author_id.slice(0, 8)}`;

  const isEdited = post.created_at !== post.updated_at;

  return (
    <div data-testid="post-card" className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="flex items-start gap-3">
        <div className="shrink-0">
          <div className="w-8 h-8 rounded-full bg-gray-600 flex items-center justify-center text-xs font-bold text-gray-300">
            {authorLabel[0]}
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-200">{authorLabel}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full text-white ${TAG_COLORS[post.tag]}`}>
              {TAG_LABELS[post.tag]}
            </span>
            {primaryTimestamp && (
              <a
                href={generateOsuLink(primaryTimestamp.ms, primaryTimestamp.combos)}
                className="text-xs text-blue-400 hover:text-blue-300 underline"
                onClick={(e) => e.stopPropagation()}
              >
                {formatTimestamp(primaryTimestamp.ms)}
                {primaryTimestamp.combos ? ` ${primaryTimestamp.combos}` : ''}
              </a>
            )}
            <span className="text-xs text-gray-500 ml-auto">
              {new Date(post.created_at).toLocaleString()}
              {isEdited && <span className="ml-1 text-gray-400">(edited)</span>}
            </span>
          </div>

          {!isCollapsed && decryptedBody !== null && (
            <div className="mt-2">{renderBody(decryptedBody)}</div>
          )}
          {!isCollapsed && decryptedBody === null && unlocked && (
            <p className="mt-2 text-red-400 text-sm">Failed to decrypt post</p>
          )}
          {!isCollapsed && !unlocked && (
            <p className="mt-2 text-gray-500 text-sm italic">🔒 Encrypted post</p>
          )}

          {!isCollapsed && (
            <div className="mt-3 flex items-center gap-3">
              {showReplyButton && onReply && (
                <button
                  type="button"
                  onClick={() => onReply(post)}
                  className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Reply
                </button>
              )}
              {canEdit && onEdit && (
                <button
                  type="button"
                  onClick={() => onEdit(post)}
                  className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Edit
                </button>
              )}
              {canDelete && onDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(post.id)}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={toggleCollapse}
          className="shrink-0 text-gray-500 hover:text-gray-300 transition-colors"
          aria-label={isCollapsed ? 'Expand post' : 'Collapse post'}
          title={isCollapsed ? 'Expand post' : 'Collapse post'}
        >
          {isCollapsed ? '▼' : '▲'}
        </button>
      </div>
    </div>
  );
}
