import { useState } from 'react';
import type { Post, PostTag } from '../api/endpoints';
import { useEncryption } from '../contexts/EncryptionContext';
import { encrypt, postFieldAad } from '../utils/crypto';

const TAG_OPTIONS: { value: PostTag; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'suggestion', label: 'Suggestion' },
  { value: 'problem', label: 'Problem' },
  { value: 'praise', label: 'Praise' },
];

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
}

export default function CreatePostForm({
  mapsetId,
  difficultyId,
  onSubmit,
  onCancel,
  parentPost,
  editingPost,
  initialBody = '',
}: CreatePostFormProps) {
  const { isUnlocked, getKey } = useEncryption();
  const [tag, setTag] = useState<PostTag>(editingPost?.tag ?? 'general');
  const [body, setBody] = useState(initialBody);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlocked = isUnlocked(mapsetId);
  const isReply = !!parentPost && !editingPost;
  const isEdit = !!editingPost;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!body.trim()) {
      setError('Post body cannot be empty.');
      return;
    }

    if (!unlocked) {
      setError('Mapset is locked. Please unlock it first.');
      return;
    }

    setIsSubmitting(true);
    try {
      const key = await getKey(mapsetId);
      if (!key) {
        setError('Encryption key not available.');
        setIsSubmitting(false);
        return;
      }

      const postId = editingPost?.id ?? crypto.randomUUID();
      const encryptedBody = await encrypt(key, body, postFieldAad(postId, mapsetId));

      await onSubmit({
        id: postId,
        tag,
        encrypted_body: encryptedBody,
        parent_id: isReply ? parentPost.id : editingPost?.parent_id ?? null,
      });

      if (!isEdit) {
        setBody('');
        setTag('general');
      }
    } catch (err) {
      logger.warn('Failed to submit post:', err);
      setError('Failed to submit post. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      {!isEdit && (
        <div className="mb-3">
          <label htmlFor="post-tag" className="block text-sm font-medium text-gray-300 mb-1">
            Tag
          </label>
          <select
            id="post-tag"
            value={tag}
            onChange={(e) => setTag(e.target.value as PostTag)}
            className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {TAG_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {isReply && parentPost && (
        <div className="mb-3 text-sm text-gray-400">
          <p>
            Replying to post by{' '}
            <span className="text-gray-300 font-medium">
              User {parentPost.author_id.slice(0, 8)}
            </span>
          </p>
        </div>
      )}

      <div className="mb-3">
        <label htmlFor="post-body" className="block text-sm font-medium text-gray-300 mb-1">
          {isEdit ? 'Edit post' : isReply ? 'Reply' : 'New post'}
        </label>
        <textarea
          id="post-body"
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your post here... e.g. 00:46:140 (2,3,4) - these are too close"
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
          {isSubmitting ? 'Submitting...' : isEdit ? 'Save Changes' : isReply ? 'Reply' : 'Post'}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
