import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Post, PostTag } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { encrypt, postFieldAad } from '../utils/crypto';
import { extractFirstTimestamp, formatTimestamp } from '../utils/extractTimestamp';
import { logger } from '../utils/logger';

const TAG_OPTIONS = [
  { value: 'general', labelKey: 'createPostForm.tagGeneral' },
  { value: 'suggestion', labelKey: 'createPostForm.tagSuggestion' },
  { value: 'problem', labelKey: 'createPostForm.tagProblem' },
  { value: 'praise', labelKey: 'createPostForm.tagPraise' },
] as const satisfies ReadonlyArray<{ value: PostTag; labelKey: string }>;

interface CreatePostFormProps {
  mapsetId: string;
  difficultyId: string;
  onSubmit: (payload: {
    id: string;
    tag: PostTag;
    encrypted_body: string;
    parent_id?: string | null;
  }) => void | Promise<void>;
  onCancel?: () => void;
  /** When provided, this form is in reply mode. */
  parentPost?: Post | null;
  /** When provided, this form is in edit mode. */
  editingPost?: Post | null;
  /** Existing decrypted body when in edit mode. */
  initialBody?: string;
  /** When set and the submitted body has no timestamp, this ms value is prepended as a timestamp.
   *  Only applies to new posts (not replies or edits). */
  defaultTimestampMs?: number | null;
  /** When set in reply mode, a second submit button appears alongside the regular Reply button.
   *  'resolve' → "Reply & Resolve"; 'reopen' → "Reopen". */
  resolveAction?: 'resolve' | 'reopen';
}

export default function CreatePostForm({
  mapsetId,
  difficultyId: _difficultyId,
  onSubmit,
  onCancel,
  parentPost,
  editingPost,
  initialBody = '',
  defaultTimestampMs = null,
  resolveAction,
}: CreatePostFormProps) {
  const { t } = useTranslation();
  const { isUnlocked, getKey } = useEncryption();
  const [tag, setTag] = useState<PostTag>(editingPost?.tag ?? 'general');
  const [body, setBody] = useState(initialBody);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlocked = isUnlocked(mapsetId);
  const isReply = !!parentPost && !editingPost;
  const isEdit = !!editingPost;

  async function doSubmit(submittedTag: PostTag) {
    setError(null);

    if (!body.trim()) {
      setError(t('createPostForm.errorEmpty'));
      return;
    }

    if (!unlocked) {
      setError(t('createPostForm.errorLocked'));
      return;
    }

    setIsSubmitting(true);
    try {
      const key = await getKey(mapsetId);
      if (!key) {
        setError(t('createPostForm.errorKeyMissing'));
        setIsSubmitting(false);
        return;
      }

      const postId = editingPost?.id ?? crypto.randomUUID();
      const finalBody =
        !isEdit && !isReply && defaultTimestampMs !== null && !extractFirstTimestamp(body)
          ? `${formatTimestamp(defaultTimestampMs)} - ${body}`
          : body;
      const encryptedBody = await encrypt(key, finalBody, postFieldAad(postId, mapsetId));

      await onSubmit({
        id: postId,
        tag: submittedTag,
        encrypted_body: encryptedBody,
        parent_id: isReply ? parentPost.id : editingPost?.parent_id ?? null,
      });

      if (!isEdit) {
        setBody('');
        setTag('general');
      }
    } catch (err) {
      logger.warn('Failed to submit post:', err);
      setError(t('createPostForm.errorGeneric'));
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    doSubmit(tag);
  }

  return (
    <form onSubmit={handleSubmit} className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      {!isEdit && !isReply && (
        <div className="mb-3">
          <label htmlFor="post-tag" className="block text-sm font-medium text-gray-300 mb-1">
            {t('createPostForm.tagLabel')}
          </label>
          <select
            id="post-tag"
            value={tag}
            onChange={(e) => setTag(e.target.value as PostTag)}
            className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {TAG_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </option>
            ))}
          </select>
        </div>
      )}

      {isReply && parentPost && (
        <div className="mb-3 text-sm text-gray-400">
          <p>
            {t('createPostForm.replyingTo')}{' '}
            <span className="text-gray-300 font-medium">
              {t('createPostForm.userPrefix', { id: parentPost.author_id.slice(0, 8) })}
            </span>
          </p>
        </div>
      )}

      <div className="mb-3">
        <label htmlFor="post-body" className="block text-sm font-medium text-gray-300 mb-1">
          {isEdit ? t('createPostForm.editPost') : isReply ? t('createPostForm.reply') : t('createPostForm.newPost')}
        </label>
        <textarea
          id="post-body"
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t('createPostForm.bodyPlaceholder')}
          className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
          disabled={isSubmitting}
        />
      </div>

      {error && (
        <p className="text-sm text-red-400 mb-3">{error}</p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isSubmitting}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
        >
          {isSubmitting
            ? t('createPostForm.submitting')
            : isEdit
              ? t('createPostForm.submitEdit')
              : isReply
                ? t('createPostForm.submitReply')
                : t('createPostForm.submitNew')}
        </button>
        {isReply && resolveAction && (
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => doSubmit(resolveAction)}
            className={`px-4 py-2 disabled:bg-gray-600 text-white text-sm font-medium rounded transition-colors ${
              resolveAction === 'resolve'
                ? 'bg-green-600 hover:bg-green-500'
                : 'bg-orange-600 hover:bg-orange-500'
            }`}
          >
            {resolveAction === 'resolve'
              ? t('createPostForm.submitReplyResolve')
              : t('createPostForm.submitReplyReopen')}
          </button>
        )}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
          >
            {t('common.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}
