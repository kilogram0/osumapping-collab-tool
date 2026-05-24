import { useTranslation } from 'react-i18next';
import type { DecryptedPost } from '../types';

interface ResolveEventProps {
  post: DecryptedPost;
  author?: { username: string; avatar_url: string } | null;
  currentUserId: string;
  isOwner: boolean;
  onDelete?: (postId: string) => void;
}

export default function ResolveEvent({
  post,
  author,
  currentUserId,
  isOwner,
  onDelete,
}: ResolveEventProps) {
  const { t } = useTranslation();
  const isResolve = post.tag === 'resolve';
  const authorName = author?.username ?? t('postCard.userPrefix', { id: post.author_id.slice(0, 8) });
  const isAuthor = post.author_id === currentUserId;
  const canDelete = isAuthor || isOwner;

  const containerClass = isResolve
    ? 'bg-green-900/20 border border-green-800/40'
    : 'bg-orange-900/20 border border-orange-800/40';
  const iconClass = isResolve ? 'text-green-400' : 'text-orange-400';
  const textClass = isResolve ? 'text-green-300' : 'text-orange-300';

  return (
    <div
      data-testid="resolve-event"
      className={`flex items-start gap-2 px-3 py-2 rounded ${containerClass}`}
    >
      <span className={`text-sm font-bold leading-5 shrink-0 ${iconClass}`} aria-hidden="true">
        {isResolve ? '✓' : '↺'}
      </span>
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${textClass}`}>
          <span className="font-medium">{authorName}</span>
          {' '}
          {isResolve ? t('resolveEvent.resolved') : t('resolveEvent.reopened')}
        </p>
        {post.decryptedBody && (
          <p className="text-xs text-gray-400 mt-0.5 whitespace-pre-wrap">{post.decryptedBody}</p>
        )}
      </div>
      <span className="text-xs text-gray-500 shrink-0 leading-5">
        {new Date(post.created_at).toLocaleString()}
      </span>
      {canDelete && onDelete && (
        <button
          type="button"
          onClick={() => onDelete(post.id)}
          className="text-xs text-red-400 hover:text-red-300 transition-colors shrink-0 leading-5"
        >
          {t('postCard.delete')}
        </button>
      )}
    </div>
  );
}
