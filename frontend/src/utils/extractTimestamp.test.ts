import { describe, it, expect } from 'vitest';
import {
  extractFirstTimestamp,
  findAllTimestamps,
  generateOsuLink,
  formatTimestamp,
} from './extractTimestamp';

describe('extractFirstTimestamp', () => {
  it('extracts a simple timestamp', () => {
    const result = extractFirstTimestamp('00:46:140 - these are too close');
    expect(result).toEqual({ ms: 46 * 1000 + 140, combos: undefined });
  });

  it('extracts a timestamp with combos', () => {
    const result = extractFirstTimestamp('00:46:140 (2,3,4) - these are too close');
    expect(result).toEqual({ ms: 46 * 1000 + 140, combos: '(2,3,4)' });
  });

  it('extracts the first timestamp from multiple', () => {
    const result = extractFirstTimestamp(
      '00:46:140 (2,3,4) - these are too close. Also 01:47:766 feels empty.',
    );
    expect(result?.ms).toBe(46 * 1000 + 140);
    expect(result?.combos).toBe('(2,3,4)');
  });

  it('returns null when no timestamp is present', () => {
    const result = extractFirstTimestamp('This post has no timestamps');
    expect(result).toBeNull();
  });

  it('handles hours correctly', () => {
    const result = extractFirstTimestamp('01:00:000');
    expect(result?.ms).toBe(60000);
  });

  it('handles single digit combos', () => {
    const result = extractFirstTimestamp('01:47:766 (5)');
    expect(result).toEqual({ ms: 107766, combos: '(5)' });
  });
});

describe('findAllTimestamps', () => {
  it('finds all timestamps in a string', () => {
    const result = findAllTimestamps(
      '00:46:140 (2,3,4) - too close. Also 01:47:766 feels empty.',
    );
    expect(result).toHaveLength(2);
    expect(result[0].ms).toBe(46140);
    expect(result[0].combos).toBe('(2,3,4)');
    expect(result[1].ms).toBe(107766);
    expect(result[1].combos).toBeUndefined();
  });

  it('returns empty array when no timestamps', () => {
    const result = findAllTimestamps('No timestamps here');
    expect(result).toEqual([]);
  });

  it('captures raw and index for each match', () => {
    const result = findAllTimestamps('Start at 00:10:000 then 00:20:000');
    expect(result[0].raw).toBe('00:10:000');
    expect(result[0].index).toBe(9);
    expect(result[1].raw).toBe('00:20:000');
    expect(result[1].index).toBe(24);
  });
});

describe('generateOsuLink', () => {
  it('generates a basic osu://edit link', () => {
    expect(generateOsuLink(46140)).toBe('osu://edit/00:46:140');
  });

  it('generates a link with combos', () => {
    expect(generateOsuLink(46140, '(2,3,4)')).toBe('osu://edit/00:46:140%20(2%2C3%2C4)');
  });

  it('handles zero ms correctly', () => {
    expect(generateOsuLink(0)).toBe('osu://edit/00:00:000');
  });
});

describe('formatTimestamp', () => {
  it('formats milliseconds correctly', () => {
    expect(formatTimestamp(46140)).toBe('00:46:140');
  });

  it('pads single digits', () => {
    expect(formatTimestamp(5005)).toBe('00:05:005');
  });
});
