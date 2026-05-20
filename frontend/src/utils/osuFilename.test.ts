import { describe, it, expect } from 'vitest';
import { composeOsuFilename, sanitizeFilenamePart } from './osuFilename';

describe('sanitizeFilenamePart', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(sanitizeFilenamePart(null)).toBe('');
    expect(sanitizeFilenamePart(undefined)).toBe('');
    expect(sanitizeFilenamePart('')).toBe('');
  });

  it('strips filesystem-unsafe characters', () => {
    expect(sanitizeFilenamePart('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('collapses internal whitespace and trims edges', () => {
    expect(sanitizeFilenamePart('   foo \t  bar   ')).toBe('foo bar');
  });
});

describe('composeOsuFilename', () => {
  it('builds canonical osu! filename', () => {
    expect(
      composeOsuFilename({
        artist: 'Camellia',
        title: 'Exit This Earth\'s Atomosphere',
        mapsetTitle: 'My Mapset',
        diffName: 'Insane_version_3',
      }),
    ).toBe('Camellia - Exit This Earth\'s Atomosphere (My Mapset) [Insane_version_3].osu');
  });

  it('uses fallbacks for missing pieces', () => {
    expect(
      composeOsuFilename({ artist: null, title: '', mapsetTitle: undefined, diffName: '' }),
    ).toBe('Unknown Artist - Unknown Song (Mapset) [Difficulty].osu');
  });

  it('sanitizes unsafe characters across all pieces', () => {
    expect(
      composeOsuFilename({
        artist: 'A/B',
        title: 'T:T',
        mapsetTitle: 'M*S',
        diffName: 'D?V',
      }),
    ).toBe('A_B - T_T (M_S) [D_V].osu');
  });
});
