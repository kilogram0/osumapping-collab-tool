import { describe, it, expect } from 'vitest';
import { compareRootPostOrder, compareReplyOrder } from './postSort';
import type { DecryptedPost } from '../types';

function makePost(overrides: Partial<DecryptedPost> & { id: string }): DecryptedPost {
  return {
    difficulty_id: 'd1',
    author_id: 'u1',
    parent_id: null,
    tag: 'suggestion',
    encrypted_body: '',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    decryptedBody: '',
    extractedMs: null,
    ...overrides,
  };
}

describe('compareRootPostOrder', () => {
  it('sorts by extractedMs when both have timestamps', () => {
    const a = makePost({ id: 'a', extractedMs: 10000 });
    const b = makePost({ id: 'b', extractedMs: 5000 });
    expect(compareRootPostOrder(a, b)).toBeGreaterThan(0);
    expect(compareRootPostOrder(b, a)).toBeLessThan(0);
  });

  it('puts timestamped post before untimstamped post', () => {
    const a = makePost({ id: 'a', extractedMs: 10000 });
    const b = makePost({ id: 'b', extractedMs: null });
    expect(compareRootPostOrder(a, b)).toBeLessThan(0);
    expect(compareRootPostOrder(b, a)).toBeGreaterThan(0);
  });

  it('sorts by created_at when neither has a timestamp', () => {
    const a = makePost({ id: 'a', extractedMs: null, created_at: '2024-01-01T02:00:00Z' });
    const b = makePost({ id: 'b', extractedMs: null, created_at: '2024-01-01T01:00:00Z' });
    expect(compareRootPostOrder(a, b)).toBeGreaterThan(0);
    expect(compareRootPostOrder(b, a)).toBeLessThan(0);
  });

  it('is stable: equal extractedMs falls back to created_at', () => {
    const a = makePost({ id: 'a', extractedMs: 5000, created_at: '2024-01-01T02:00:00Z' });
    const b = makePost({ id: 'b', extractedMs: 5000, created_at: '2024-01-01T01:00:00Z' });
    expect(compareRootPostOrder(a, b)).toBeGreaterThan(0);
  });
});

describe('compareReplyOrder', () => {
  it('sorts strictly by created_at regardless of extractedMs', () => {
    const early = makePost({ id: 'a', parent_id: 'root', extractedMs: 99999, created_at: '2024-01-01T01:00:00Z' });
    const late  = makePost({ id: 'b', parent_id: 'root', extractedMs: 1,     created_at: '2024-01-01T02:00:00Z' });
    expect(compareReplyOrder(early, late)).toBeLessThan(0);
    expect(compareReplyOrder(late, early)).toBeGreaterThan(0);
  });

  it('earlier post time wins even when the reply has a large timestamp', () => {
    const first  = makePost({ id: 'a', parent_id: 'root', extractedMs: null,  created_at: '2024-01-01T01:00:00Z' });
    const second = makePost({ id: 'b', parent_id: 'root', extractedMs: 5000,  created_at: '2024-01-01T02:00:00Z' });
    expect(compareReplyOrder(first, second)).toBeLessThan(0);
  });
});

describe('sort integration: root ordering is independent of replies', () => {
  it('roots sort by extractedMs after tree split', () => {
    const posts = [
      makePost({ id: 'r2', extractedMs: 10000, created_at: '2024-01-01T01:00:00Z' }),
      makePost({ id: 'r1', extractedMs: 5000,  created_at: '2024-01-01T03:00:00Z' }),
      makePost({ id: 'reply', parent_id: 'r2', extractedMs: null, created_at: '2024-01-01T02:00:00Z' }),
    ];
    const topLevel = posts.filter((p) => p.parent_id === null);
    topLevel.sort(compareRootPostOrder);
    expect(topLevel.map((p) => p.id)).toEqual(['r1', 'r2']);
  });

  it('replies sort by created_at after tree split', () => {
    const posts = [
      makePost({ id: 'rep3', parent_id: 'root', extractedMs: 1000, created_at: '2024-01-01T03:00:00Z' }),
      makePost({ id: 'rep1', parent_id: 'root', extractedMs: 9999, created_at: '2024-01-01T01:00:00Z' }),
      makePost({ id: 'rep2', parent_id: 'root', extractedMs: null, created_at: '2024-01-01T02:00:00Z' }),
    ];
    const replies = posts.filter((p) => p.parent_id !== null);
    replies.sort(compareReplyOrder);
    expect(replies.map((p) => p.id)).toEqual(['rep1', 'rep2', 'rep3']);
  });
});
