import { describe, it, expect } from 'vitest';
import { findNextSection } from './sectionOrder';
import type { DecryptedSection } from '../components/SectionList';

function s(id: string, sortOrder: number): DecryptedSection {
  return {
    id,
    name: id,
    startTimeMs: 0,
    endTimeMs: 0,
    sortOrder,
    assignedTo: null,
  };
}

describe('findNextSection', () => {
  it('returns the next section by sortOrder', () => {
    const sections = [s('a', 0), s('b', 1), s('c', 2)];
    expect(findNextSection(sections, 'a')?.id).toBe('b');
    expect(findNextSection(sections, 'b')?.id).toBe('c');
  });

  it('returns null for the final section — signals that delete must be refused', () => {
    const sections = [s('a', 0), s('b', 1)];
    expect(findNextSection(sections, 'b')).toBeNull();
  });

  it('returns null for an unknown id', () => {
    const sections = [s('a', 0), s('b', 1)];
    expect(findNextSection(sections, 'missing')).toBeNull();
  });

  it('uses id as a stable tiebreaker when sortOrder is equal', () => {
    // sortOrder ties resolve by lexicographic id, so 'b' follows 'a'.
    const sections = [s('b', 0), s('a', 0), s('c', 0)];
    expect(findNextSection(sections, 'a')?.id).toBe('b');
    expect(findNextSection(sections, 'b')?.id).toBe('c');
    expect(findNextSection(sections, 'c')).toBeNull();
  });

  it('does not mutate the input array', () => {
    const sections = [s('b', 1), s('a', 0)];
    const before = [...sections];
    findNextSection(sections, 'a');
    expect(sections).toEqual(before);
  });
});
