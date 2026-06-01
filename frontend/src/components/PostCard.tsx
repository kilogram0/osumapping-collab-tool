import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Post, PostTag } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { decrypt, postFieldAad } from '../utils/crypto';
import { extractFirstTimestamp, findAllTimestamps, generateOsuLink, formatTimestamp } from '../utils/extractTimestamp';
import { logger } from '../utils/logger';
import { TagIcon } from './postTagIcons';

const IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

interface PostCardProps {
  post: Post;
  mapsetId: string;
  currentUserId: string;
  isOwner: boolean;
  /** When provided, decryption is skipped and this plaintext is used directly. */
  decryptedBody?: string | null;
  /** Author profile (username + avatar) resolved from the mapset members list.
   *  When omitted, falls back to a generic placeholder. */
  author?: { username: string; avatar_url: string } | null;
  /** If false, the Reply button is hidden even when onReply is provided. */
  showReplyButton?: boolean;
  /** True when this root post has been resolved (last status reply has tag 'resolve'). */
  isResolved?: boolean;
  /** Controlled collapse state. When `onToggleCollapse` is omitted the toggle
   *  button is hidden and the body is always shown (used for reply posts —
   *  collapse is owned by the root). */
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  onReply?: (post: Post) => void;
  onEdit?: (post: Post) => void;
  onDelete?: (postId: string) => void;
}

const TAG_COLORS: Record<PostTag, string> = {
  problem: 'bg-red-500',
  suggestion: 'bg-yellow-500',
  praise: 'bg-blue-500',
  general: 'bg-purple-500',
  resolve: 'bg-green-500',
  reopen: 'bg-orange-500',
};

const TAG_LABEL_KEYS = {
  general: 'postCard.tagGeneral',
  suggestion: 'postCard.tagSuggestion',
  problem: 'postCard.tagProblem',
  praise: 'postCard.tagPraise',
  resolve: 'postCard.tagResolve',
  reopen: 'postCard.tagReopen',
} as const satisfies Record<PostTag, string>;

export default function PostCard({
  post,
  mapsetId,
  currentUserId,
  isOwner,
  decryptedBody: propDecryptedBody,
  author,
  showReplyButton = true,
  isResolved = false,
  isCollapsed = false,
  onToggleCollapse,
  onReply,
  onEdit,
  onDelete,
}: PostCardProps) {
  const { t } = useTranslation();
  const { isUnlocked, getKey } = useEncryption();
  const unlocked = isUnlocked(mapsetId);
  const [decryptedBody, setDecryptedBody] = useState<string | null>(propDecryptedBody ?? null);
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

  // Alt text is excluded so timestamp-shaped alts don't become header chips.
  function stripImageAltText(text: string): string {
    return text.replace(IMAGE_RE, (_match, _alt, url) => `![](${url})`);
  }

  const primaryTimestamp = decryptedBody ? extractFirstTimestamp(stripImageAltText(decryptedBody)) : null;

  function renderBody(text: string): React.ReactNode {
    type Token =
      | { kind: 'timestamp'; ms: number; combos?: string; raw: string; index: number }
      | { kind: 'image'; alt: string; url: string; raw: string; index: number };

    // Collect image tokens and record their alt text spans so timestamps inside alt text are excluded.
    const imageTokens: (Token & { kind: 'image' })[] = [];
    IMAGE_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = IMAGE_RE.exec(text)) !== null) {
      imageTokens.push({ kind: 'image', alt: im[1], url: im[2], raw: im[0], index: im.index });
    }

    const altSpans = imageTokens.map(t => ({ start: t.index + 2, end: t.index + 2 + t.alt.length }));

    const tokens: Token[] = [...imageTokens];
    for (const m of findAllTimestamps(text)) {
      const inAlt = altSpans.some(s => m.index >= s.start && m.index + m.raw.length <= s.end);
      if (!inAlt) {
        tokens.push({ kind: 'timestamp', ms: m.ms, combos: m.combos, raw: m.raw, index: m.index });
      }
    }

    tokens.sort((a, b) => a.index - b.index);

    if (tokens.length === 0) {
      return <p className="text-gray-200 whitespace-pre-wrap">{text}</p>;
    }

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;

    for (const token of tokens) {
      if (token.index < lastIndex) continue;

      if (token.index > lastIndex) {
        parts.push(
          <span key={`text-${lastIndex}`}>{text.slice(lastIndex, token.index)}</span>,
        );
      }

      if (token.kind === 'timestamp') {
        const link = generateOsuLink(token.ms, token.combos);
        parts.push(
          <a
            key={`link-${token.index}`}
            href={link}
            className="text-blue-400 hover:text-blue-300 underline"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            {token.raw}
          </a>,
        );
      } else {
        parts.push(
          <img
            key={`img-${token.index}`}
            src={token.url}
            alt={token.alt}
            className="max-w-full max-h-96 object-contain rounded my-1"
            loading="lazy"
            referrerPolicy="no-referrer"
            onClick={(e) => e.stopPropagation()}
          />,
        );
      }

      lastIndex = token.index + token.raw.length;
    }

    if (lastIndex < text.length) {
      parts.push(<span key="text-end">{text.slice(lastIndex)}</span>);
    }

    return <p className="text-gray-200 whitespace-pre-wrap">{parts}</p>;
  }

  const resolvedName = author?.username ?? t('postCard.userPrefix', { id: post.author_id.slice(0, 8) });
  const authorLabel = isAuthor ? `${resolvedName} ${t('postCard.youSuffix')}` : resolvedName;

  const isEdited = post.created_at !== post.updated_at;

  const isRootPost = post.parent_id === null;

  return (
    <div
      data-testid="post-card"
      className={`bg-gray-850 border rounded-lg p-4 ${isRootPost && isResolved ? 'border-green-600' : 'border-gray-700'}`}
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0">
          {author?.avatar_url ? (
            <img
              src={author.avatar_url}
              alt=""
              className="w-8 h-8 rounded-full bg-gray-600 object-cover"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-gray-600 flex items-center justify-center text-xs font-bold text-gray-300">
              {resolvedName[0]}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-200">{authorLabel}</span>
            {!post.parent_id && (
              <span className={`text-xs px-2 py-0.5 rounded-full text-white inline-flex items-center gap-1 ${TAG_COLORS[post.tag]}`}>
                <TagIcon tag={post.tag} />
                {t(TAG_LABEL_KEYS[post.tag])}
              </span>
            )}
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
              {isEdited && <span className="ml-1 text-gray-400">{t('postCard.edited')}</span>}
            </span>
          </div>

          {!isCollapsed && decryptedBody !== null && (
            <div className="mt-2">{renderBody(decryptedBody)}</div>
          )}
          {!isCollapsed && decryptedBody === null && unlocked && (
            <p className="mt-2 text-red-400 text-sm">{t('postCard.failedDecrypt')}</p>
          )}
          {!isCollapsed && !unlocked && (
            <p className="mt-2 text-gray-500 text-sm italic">{t('postCard.encrypted')}</p>
          )}

          {!isCollapsed && (
            <div className="mt-3 flex items-center gap-3">
              {showReplyButton && onReply && (
                <button
                  type="button"
                  onClick={() => onReply(post)}
                  className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {t('postCard.reply')}
                </button>
              )}
              {canEdit && onEdit && (
                <button
                  type="button"
                  onClick={() => onEdit(post)}
                  className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {t('postCard.edit')}
                </button>
              )}
              {canDelete && onDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(post.id)}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  {t('postCard.delete')}
                </button>
              )}
            </div>
          )}
        </div>
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            className="shrink-0 text-gray-500 hover:text-gray-300 transition-colors"
            aria-label={isCollapsed ? t('postCard.expand') : t('postCard.collapse')}
            title={isCollapsed ? t('postCard.expand') : t('postCard.collapse')}
          >
            {isCollapsed ? '▼' : '▲'}
          </button>
        )}
      </div>
    </div>
  );
}
