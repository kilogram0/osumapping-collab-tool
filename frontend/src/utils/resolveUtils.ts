import type { PostTag } from '../api/endpoints';
import type { DecryptedPost } from '../types';

export interface PostTree {
  topLevel: DecryptedPost[];
  replyMap: Map<string, DecryptedPost[]>;
}

/** Returns the set of root post IDs whose last status reply (resolve/reopen) is 'resolve'. */
export function deriveResolvedRootIds(postTree: PostTree): Set<string> {
  const resolved = new Set<string>();
  for (const rootPost of postTree.topLevel) {
    const statusReplies = (postTree.replyMap.get(rootPost.id) ?? [])
      .filter((r) => isStatusReply(r.tag))
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    if (statusReplies.length > 0 && statusReplies[statusReplies.length - 1].tag === 'resolve') {
      resolved.add(rootPost.id);
    }
  }
  return resolved;
}

/** Only problem and suggestion threads have a resolution workflow. */
export function canBeResolved(tag: PostTag): boolean {
  return tag === 'problem' || tag === 'suggestion';
}

export function isStatusReply(tag: PostTag): boolean {
  return tag === 'resolve' || tag === 'reopen';
}
