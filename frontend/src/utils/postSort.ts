import type { DecryptedPost } from '../types';

/** Root posts: by timestamp position, then by creation time. */
export function compareRootPostOrder(a: DecryptedPost, b: DecryptedPost): number {
  if (a.extractedMs !== null && b.extractedMs !== null) {
    const delta = a.extractedMs - b.extractedMs;
    if (delta !== 0) return delta;
  } else if (a.extractedMs !== null) {
    return -1;
  } else if (b.extractedMs !== null) {
    return 1;
  }
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

/** Replies: chronological only — they form a conversation thread. */
export function compareReplyOrder(a: DecryptedPost, b: DecryptedPost): number {
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}
