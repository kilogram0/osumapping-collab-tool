import { describe, it, expect } from 'vitest';
import { deriveResolvedRootIds, canBeResolved } from './resolveUtils';
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

describe('deriveResolvedRootIds', () => {
  it('returns empty set when there are no status replies', () => {
    const root = makePost({ id: 'r1' });
    const result = deriveResolvedRootIds({
      topLevel: [root],
      replyMap: new Map([['r1', [makePost({ id: 'rep1', parent_id: 'r1', tag: 'general' })]]]),
    });
    expect(result.size).toBe(0);
  });

  it('marks root as resolved when last status reply is resolve', () => {
    const root = makePost({ id: 'r1' });
    const result = deriveResolvedRootIds({
      topLevel: [root],
      replyMap: new Map([['r1', [makePost({ id: 'rev1', parent_id: 'r1', tag: 'resolve', created_at: '2024-01-01T01:00:00Z' })]]]),
    });
    expect(result.has('r1')).toBe(true);
  });

  it('does not mark root as resolved when last status reply is reopen', () => {
    const root = makePost({ id: 'r1' });
    const result = deriveResolvedRootIds({
      topLevel: [root],
      replyMap: new Map([
        ['r1', [
          makePost({ id: 'rev1', parent_id: 'r1', tag: 'resolve', created_at: '2024-01-01T01:00:00Z' }),
          makePost({ id: 'rev2', parent_id: 'r1', tag: 'reopen',  created_at: '2024-01-01T02:00:00Z' }),
        ]],
      ]),
    });
    expect(result.has('r1')).toBe(false);
  });

  it('uses chronological order — not array order — to determine last status', () => {
    const root = makePost({ id: 'r1' });
    // array has reopen first, but resolve has a later timestamp
    const result = deriveResolvedRootIds({
      topLevel: [root],
      replyMap: new Map([
        ['r1', [
          makePost({ id: 'rev2', parent_id: 'r1', tag: 'reopen',  created_at: '2024-01-01T01:00:00Z' }),
          makePost({ id: 'rev1', parent_id: 'r1', tag: 'resolve', created_at: '2024-01-01T02:00:00Z' }),
        ]],
      ]),
    });
    expect(result.has('r1')).toBe(true);
  });

  it('handles multiple root posts independently', () => {
    const r1 = makePost({ id: 'r1' });
    const r2 = makePost({ id: 'r2' });
    const result = deriveResolvedRootIds({
      topLevel: [r1, r2],
      replyMap: new Map([
        ['r1', [makePost({ id: 'a', parent_id: 'r1', tag: 'resolve', created_at: '2024-01-01T01:00:00Z' })]],
        ['r2', [makePost({ id: 'b', parent_id: 'r2', tag: 'reopen',  created_at: '2024-01-01T01:00:00Z' })]],
      ]),
    });
    expect(result.has('r1')).toBe(true);
    expect(result.has('r2')).toBe(false);
  });

  it('returns empty set for a root with no replies at all', () => {
    const result = deriveResolvedRootIds({
      topLevel: [makePost({ id: 'r1' })],
      replyMap: new Map(),
    });
    expect(result.size).toBe(0);
  });
});

describe('canBeResolved', () => {
  it('returns true for suggestion and problem', () => {
    expect(canBeResolved('suggestion')).toBe(true);
    expect(canBeResolved('problem')).toBe(true);
  });

  it('returns false for general and praise', () => {
    expect(canBeResolved('general')).toBe(false);
    expect(canBeResolved('praise')).toBe(false);
  });
});
