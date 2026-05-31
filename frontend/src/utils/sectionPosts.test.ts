import { describe, it, expect } from 'vitest';
import { filterPostsBySection } from './sectionPosts';
import type { DecryptedPost } from '../types';

function post(overrides: Partial<DecryptedPost> & { id: string }): DecryptedPost {
  return {
    difficulty_id: 'd1',
    author_id: 'u1',
    parent_id: null,
    tag: 'general',
    encrypted_body: 'enc:',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    decryptedBody: '',
    extractedMs: null,
    ...overrides,
  };
}

// Section spans [0, 30000].
const RANGE = { startTimeMs: 0, endTimeMs: 30000 };

const P1 = post({ id: 'p1', tag: 'suggestion', extractedMs: 15000 }); // inside
const P2 = post({ id: 'p2', tag: 'problem', extractedMs: 45000 }); // outside
const P3 = post({ id: 'p3', extractedMs: null }); // no timestamp
const BASE = [P1, P2, P3];

describe('filterPostsBySection', () => {
  it('keeps top-level posts whose timestamp is in range', () => {
    const result = filterPostsBySection(BASE, RANGE).map((p) => p.id);
    expect(result).toContain('p1');
    expect(result).not.toContain('p2'); // 45000 is past the end
    expect(result).not.toContain('p3'); // no timestamp
  });

  it('keeps a reply when its root post is in the section even if the reply has no timestamp', () => {
    const reply = post({ id: 'r1', parent_id: 'p1', extractedMs: null });
    const result = filterPostsBySection([...BASE, reply], RANGE).map((p) => p.id);
    expect(result).toEqual(expect.arrayContaining(['p1', 'r1']));
  });

  it('keeps a reply when its root is in the section even if the reply timestamp is outside', () => {
    const reply = post({ id: 'r2', parent_id: 'p1', extractedMs: 90000 });
    const result = filterPostsBySection([...BASE, reply], RANGE).map((p) => p.id);
    expect(result).toContain('r2');
  });

  it('drops replies whose root post is outside the section', () => {
    const reply = post({ id: 'r3', parent_id: 'p2', extractedMs: null });
    const result = filterPostsBySection([...BASE, reply], RANGE).map((p) => p.id);
    expect(result).not.toContain('r3');
  });

  it('anchors deeply nested replies to the section root', () => {
    const reply1 = post({ id: 'r1', parent_id: 'p1' });
    const reply2 = post({ id: 'r2', parent_id: 'r1' });
    const result = filterPostsBySection([...BASE, reply1, reply2], RANGE).map((p) => p.id);
    expect(result).toEqual(expect.arrayContaining(['r1', 'r2']));
  });

  it('uses a half-open upper bound by default but inclusive for the last section', () => {
    const onBoundary = post({ id: 'edge', extractedMs: 30000 });
    const half = filterPostsBySection([onBoundary], RANGE).map((p) => p.id);
    expect(half).not.toContain('edge');
    const inclusive = filterPostsBySection([onBoundary], { ...RANGE, isLastSection: true }).map((p) => p.id);
    expect(inclusive).toContain('edge');
  });

  it('does not loop forever on a parent-chain cycle', () => {
    const a = post({ id: 'a', parent_id: 'b' });
    const b = post({ id: 'b', parent_id: 'a' });
    expect(() => filterPostsBySection([a, b], RANGE)).not.toThrow();
  });
});
