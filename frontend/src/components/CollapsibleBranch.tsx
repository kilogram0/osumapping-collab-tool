import { useCallback, useState } from 'react';

const storageKey = (userId: string, postId: string): string =>
  `post-collapsed:${userId}:${postId}`;

interface CollapsibleBranchProps {
  userId: string;
  postId: string;
  children: (collapsed: boolean, toggle: () => void) => React.ReactNode;
}

// Wraps a root post so its collapse state can be owned by the parent render
// loop without violating the rules of hooks. Children-as-function is used so
// that consumers can decide which siblings (e.g. replies) live inside the
// !collapsed branch.
export default function CollapsibleBranch({ userId, postId, children }: CollapsibleBranchProps) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(storageKey(userId, postId)) === 'true';
    } catch {
      return false;
    }
  });

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey(userId, postId), String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, [userId, postId]);

  return <>{children(collapsed, toggle)}</>;
}
