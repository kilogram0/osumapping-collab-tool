import { describe, it, expect } from 'vitest';
import { diffBase, normalizeCriticalLines, normalizeFromBase } from './osuBase';

// ------------------------------------------------------------------
// Base fixture
// ------------------------------------------------------------------

const ACTIVE_BASE = `osu file format v14

[General]
AudioFilename: audio.mp3
AudioLeadIn: 0
PreviewTime: -1
Countdown: 1
SampleSet: Normal

[Editor]
Bookmarks: 1000,2000
DistanceSpacing: 1.2

[Metadata]
Title:Test Song
Artist:Test Artist
Creator:Mapper
Version:Easy
Source:
Tags:

[Difficulty]
HPDrainRate:4
CircleSize:3
OverallDifficulty:3
ApproachRate:4
SliderMultiplier:1.4
SliderTickRate:1

[Events]
0,0,"bg.jpg",0,0
//Break Periods
2,1000,2000

[TimingPoints]
0,500,4,2,1,50,1,0
2000,333.33,4,2,1,50,1,0

[Colours]
Combo1 : 255,0,0
Combo2 : 0,255,0

[HitObjects]
`;

// ------------------------------------------------------------------
// diffBase
// ------------------------------------------------------------------

describe('diffBase', () => {
  it('reports no diff when bases are identical', () => {
    const report = diffBase(ACTIVE_BASE, ACTIVE_BASE);
    expect(report.critical).toEqual([]);
    expect(report.notice).toEqual([]);
    expect(report.values).toEqual({});
    expect(report.hasDiff).toBe(false);
  });

  it('detects a critical [Difficulty] change and surfaces base-vs-yours values', () => {
    const candidate = ACTIVE_BASE.replace('HPDrainRate:4', 'HPDrainRate:5');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toContain('Difficulty:HPDrainRate');
    expect(report.values['Difficulty:HPDrainRate']).toEqual({
      candidate: '5',
      active: '4',
    });
    expect(report.hasDiff).toBe(true);
  });

  it('detects multiple critical [Difficulty] changes', () => {
    const candidate = ACTIVE_BASE
      .replace('HPDrainRate:4', 'HPDrainRate:5')
      .replace('CircleSize:3', 'CircleSize:4');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toContain('Difficulty:HPDrainRate');
    expect(report.critical).toContain('Difficulty:CircleSize');
    expect(report.notice).toEqual([]);
  });

  it('detects a critical AudioFilename change with values', () => {
    const candidate = ACTIVE_BASE.replace('AudioFilename: audio.mp3', 'AudioFilename: new.ogg');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toContain('General:AudioFilename');
    expect(report.values['General:AudioFilename']).toEqual({
      candidate: 'new.ogg',
      active: 'audio.mp3',
    });
  });

  it('does not flag AudioFilename as notice when it changes', () => {
    const candidate = ACTIVE_BASE.replace('AudioFilename: audio.mp3', 'AudioFilename: new.ogg');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.notice).not.toContain('General:AudioFilename');
  });

  it('detects a notice [General] change', () => {
    const candidate = ACTIVE_BASE.replace('PreviewTime: -1', 'PreviewTime: 5000');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.notice).toContain('General:PreviewTime');
    expect(report.values['General:PreviewTime']).toEqual({
      candidate: '5000',
      active: '-1',
    });
    expect(report.critical).toEqual([]);
    expect(report.hasDiff).toBe(true);
  });

  it('detects a notice [Metadata] change', () => {
    const candidate = ACTIVE_BASE.replace('Artist:Test Artist', 'Artist:Another Artist');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.notice).toContain('Metadata:Artist');
    expect(report.values['Metadata:Artist']).toEqual({
      candidate: 'Another Artist',
      active: 'Test Artist',
    });
    expect(report.critical).toEqual([]);
  });

  it('ignores [Metadata] Version changes', () => {
    const candidate = ACTIVE_BASE.replace('Version:Easy', 'Version:Hard');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toEqual([]);
    expect(report.notice).toEqual([]);
    expect(report.hasDiff).toBe(false);
  });

  it('detects [Events] changes as notice (line list, no value pair)', () => {
    const candidate = ACTIVE_BASE.replace('2,1000,2000', '2,1000,3000');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.notice).toContain('Events');
    expect(report.values['Events']).toBeUndefined();
    expect(report.critical).toEqual([]);
  });

  it('ignores [Events] comment-only changes', () => {
    const candidate = ACTIVE_BASE.replace(
      '//Break Periods',
      '//Break Periods modified',
    );
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.notice).not.toContain('Events');
  });

  it('promotes [TimingPoints] changes to critical (line list, no value pair)', () => {
    const candidate = ACTIVE_BASE.replace(
      '0,500,4,2,1,50,1,0',
      '0,600,4,2,1,50,1,0',
    );
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toContain('TimingPoints');
    expect(report.notice).not.toContain('TimingPoints');
    expect(report.values['TimingPoints']).toBeUndefined();
  });

  it('ignores [TimingPoints] blank-line changes', () => {
    const candidate = ACTIVE_BASE.replace(
      '[TimingPoints]\n0,500,4,2,1,50,1,0',
      '[TimingPoints]\n\n0,500,4,2,1,50,1,0',
    );
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).not.toContain('TimingPoints');
    expect(report.notice).not.toContain('TimingPoints');
  });

  it('ignores [Editor] changes', () => {
    const candidate = ACTIVE_BASE.replace('Bookmarks: 1000,2000', 'Bookmarks: 3000');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toEqual([]);
    expect(report.notice).toEqual([]);
    expect(report.hasDiff).toBe(false);
  });

  it('ignores [Colours] changes', () => {
    const candidate = ACTIVE_BASE.replace('Combo1 : 255,0,0', 'Combo1 : 0,0,0');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toEqual([]);
    expect(report.notice).toEqual([]);
    expect(report.hasDiff).toBe(false);
  });

  it('ignores pre-header version changes', () => {
    const candidate = ACTIVE_BASE.replace('osu file format v14', 'osu file format v128');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toEqual([]);
    expect(report.notice).toEqual([]);
    expect(report.hasDiff).toBe(false);
  });

  it('reports both critical and notice when both buckets change', () => {
    const candidate = ACTIVE_BASE
      .replace('HPDrainRate:4', 'HPDrainRate:5')
      .replace('PreviewTime: -1', 'PreviewTime: 5000');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toContain('Difficulty:HPDrainRate');
    expect(report.notice).toContain('General:PreviewTime');
    expect(report.hasDiff).toBe(true);
  });

  it('detects added keys in candidate', () => {
    const candidate = ACTIVE_BASE.replace(
      '[Difficulty]\nHPDrainRate:4',
      '[Difficulty]\nHPDrainRate:4\nNewKey:newval',
    );
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toContain('Difficulty:NewKey');
    expect(report.values['Difficulty:NewKey']).toEqual({
      candidate: 'newval',
      active: null,
    });
  });

  it('detects removed keys in candidate', () => {
    const candidate = ACTIVE_BASE.replace('HPDrainRate:4\n', '');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toContain('Difficulty:HPDrainRate');
    expect(report.values['Difficulty:HPDrainRate']).toEqual({
      candidate: null,
      active: '4',
    });
  });

  it('detects event line additions', () => {
    const candidate = ACTIVE_BASE.replace(
      '2,1000,2000',
      '2,1000,2000\n2,3000,4000',
    );
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.notice).toContain('Events');
  });

  it('detects timing point additions as critical', () => {
    const candidate = ACTIVE_BASE.replace(
      '2000,333.33,4,2,1,50,1,0',
      '2000,333.33,4,2,1,50,1,0\n4000,250,4,2,1,50,1,0',
    );
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toContain('TimingPoints');
  });
});

// ------------------------------------------------------------------
// normalizeCriticalLines (wrapper)
// ------------------------------------------------------------------

describe('normalizeCriticalLines', () => {
  it('rewrites [Difficulty] lines to match active base', () => {
    const section = ACTIVE_BASE.replace('HPDrainRate:4', 'HPDrainRate:9');
    const rewritten = normalizeCriticalLines(section, ACTIVE_BASE);
    expect(rewritten).toContain('HPDrainRate:4');
    expect(rewritten).not.toContain('HPDrainRate:9');
  });

  it('rewrites AudioFilename to match active base', () => {
    const section = ACTIVE_BASE.replace('AudioFilename: audio.mp3', 'AudioFilename: other.ogg');
    const rewritten = normalizeCriticalLines(section, ACTIVE_BASE);
    expect(rewritten).toContain('AudioFilename:audio.mp3');
    expect(rewritten).not.toContain('AudioFilename: other.ogg');
  });

  it('preserves non-critical [General] lines (notice scope is off)', () => {
    const section = ACTIVE_BASE.replace('PreviewTime: -1', 'PreviewTime: 9999');
    const rewritten = normalizeCriticalLines(section, ACTIVE_BASE);
    expect(rewritten).toContain('PreviewTime: 9999');
  });

  it('preserves [Metadata] Version lines', () => {
    const section = ACTIVE_BASE.replace('Version:Easy', 'Version:Hard');
    const rewritten = normalizeCriticalLines(section, ACTIVE_BASE);
    expect(rewritten).toContain('Version:Hard');
  });

  it('preserves [Events] lines (notice scope is off)', () => {
    const section = ACTIVE_BASE.replace('2,1000,2000', '2,1000,9999');
    const rewritten = normalizeCriticalLines(section, ACTIVE_BASE);
    expect(rewritten).toContain('2,1000,9999');
  });

  it('rewrites positive [TimingPoints] to match active base while keeping negatives', () => {
    const sectionWithNegative = ACTIVE_BASE.replace(
      '[TimingPoints]\n0,500,4,2,1,50,1,0\n2000,333.33,4,2,1,50,1,0',
      '[TimingPoints]\n0,999,4,2,1,50,1,0\n1000,-50,4,2,1,50,0,0\n2000,333.33,4,2,1,50,1,0',
    );
    const rewritten = normalizeCriticalLines(sectionWithNegative, ACTIVE_BASE);
    // Section's positive at t=0 was 999; should be replaced by base's 500.
    expect(rewritten).toContain('0,500,4,2,1,50,1,0');
    expect(rewritten).not.toContain('0,999,4,2,1,50,1,0');
    // Negative point at t=1000 must survive.
    expect(rewritten).toContain('1000,-50,4,2,1,50,0,0');
  });

  it('preserves comments and blank lines', () => {
    const section = ACTIVE_BASE.replace('HPDrainRate:4', '// comment\nHPDrainRate:9');
    const rewritten = normalizeCriticalLines(section, ACTIVE_BASE);
    expect(rewritten).toContain('// comment');
    expect(rewritten).toContain('HPDrainRate:4');
  });

  it('does not add missing critical keys', () => {
    const section = ACTIVE_BASE.replace('HPDrainRate:4\n', '');
    const rewritten = normalizeCriticalLines(section, ACTIVE_BASE);
    expect(rewritten).not.toContain('HPDrainRate:4');
  });

  it('handles multiple [Difficulty] key rewrites', () => {
    const section = ACTIVE_BASE
      .replace('HPDrainRate:4', 'HPDrainRate:9')
      .replace('CircleSize:3', 'CircleSize:7');
    const rewritten = normalizeCriticalLines(section, ACTIVE_BASE);
    expect(rewritten).toContain('HPDrainRate:4');
    expect(rewritten).toContain('CircleSize:3');
    expect(rewritten).not.toContain('HPDrainRate:9');
    expect(rewritten).not.toContain('CircleSize:7');
  });
});

// ------------------------------------------------------------------
// normalizeFromBase (notice scope)
// ------------------------------------------------------------------

describe('normalizeFromBase notice scope', () => {
  it('rewrites non-AudioFilename [General] keys when notice scope is on', () => {
    const section = ACTIVE_BASE.replace('PreviewTime: -1', 'PreviewTime: 9999');
    const rewritten = normalizeFromBase(section, ACTIVE_BASE, { critical: false, notice: true });
    expect(rewritten).toContain('PreviewTime:-1');
    expect(rewritten).not.toContain('PreviewTime: 9999');
  });

  it('rewrites [Metadata] keys except Version when notice scope is on', () => {
    const section = ACTIVE_BASE
      .replace('Artist:Test Artist', 'Artist:Hacked Artist')
      .replace('Version:Easy', 'Version:Hard');
    const rewritten = normalizeFromBase(section, ACTIVE_BASE, { critical: false, notice: true });
    expect(rewritten).toContain('Artist:Test Artist');
    expect(rewritten).not.toContain('Artist:Hacked Artist');
    // Version is intentionally per-difficulty and never normalized.
    expect(rewritten).toContain('Version:Hard');
  });

  it('replaces [Events] wholesale when notice scope is on', () => {
    const section = ACTIVE_BASE.replace('2,1000,2000', '2,1000,2000\n2,5000,6000');
    const rewritten = normalizeFromBase(section, ACTIVE_BASE, { critical: false, notice: true });
    expect(rewritten).not.toContain('2,5000,6000');
    expect(rewritten).toContain('2,1000,2000');
  });

  it('leaves critical fields untouched when only notice scope is on', () => {
    const section = ACTIVE_BASE
      .replace('HPDrainRate:4', 'HPDrainRate:9')
      .replace('PreviewTime: -1', 'PreviewTime: 9999');
    const rewritten = normalizeFromBase(section, ACTIVE_BASE, { critical: false, notice: true });
    expect(rewritten).toContain('HPDrainRate:9');
    expect(rewritten).toContain('PreviewTime:-1');
  });

  it('applies both scopes when both flags are on', () => {
    const section = ACTIVE_BASE
      .replace('HPDrainRate:4', 'HPDrainRate:9')
      .replace('PreviewTime: -1', 'PreviewTime: 9999');
    const rewritten = normalizeFromBase(section, ACTIVE_BASE, { critical: true, notice: true });
    expect(rewritten).toContain('HPDrainRate:4');
    expect(rewritten).toContain('PreviewTime:-1');
  });

  it('returns the section byte-identical when both scopes are off', () => {
    // Caller-bug guard. The implementation has a fast path that
    // bypasses the parse/stringify roundtrip when neither scope is on,
    // so the output should be byte-identical to the input — not just
    // structurally equivalent.
    const section = ACTIVE_BASE.replace('HPDrainRate:4', 'HPDrainRate:9');
    const rewritten = normalizeFromBase(section, ACTIVE_BASE, { critical: false, notice: false });
    expect(rewritten).toBe(section);
  });

  it('after normalizing both scopes, diffBase reports no diff against the base', () => {
    // The property that actually matters in production: once we
    // normalize a section against the active base, a fresh candidate
    // base derived from that section must match the active base exactly
    // (otherwise the upload path would try to create a new base version
    // anyway — defeating the whole point of the mapper silent-normalize
    // and owner Discard flows).
    const section = ACTIVE_BASE
      .replace('HPDrainRate:4', 'HPDrainRate:9')
      .replace('CircleSize:3', 'CircleSize:7')
      .replace('PreviewTime: -1', 'PreviewTime: 9999')
      .replace('Artist:Test Artist', 'Artist:Hacked')
      .replace('2,1000,2000', '2,1000,9999');
    const normalized = normalizeFromBase(section, ACTIVE_BASE, { critical: true, notice: true });
    const report = diffBase(normalized, ACTIVE_BASE);
    expect(report.critical).toEqual([]);
    expect(report.notice).toEqual([]);
    expect(report.hasDiff).toBe(false);
  });

  it('TimingPoints normalization: at a tie, positive sorts before negative (osu! convention)', () => {
    // Base has a positive at t=1000; section has a negative at the same
    // offset. After normalization, the positive must precede the
    // negative — osu! interprets a tie as "set BPM, then modify SV".
    const baseWithTiedPositive = ACTIVE_BASE.replace(
      '[TimingPoints]\n0,500,4,2,1,50,1,0\n2000,333.33,4,2,1,50,1,0',
      '[TimingPoints]\n1000,500,4,2,1,50,1,0',
    );
    const sectionWithTiedNegative = ACTIVE_BASE.replace(
      '[TimingPoints]\n0,500,4,2,1,50,1,0\n2000,333.33,4,2,1,50,1,0',
      '[TimingPoints]\n1000,-50,4,2,1,50,0,0',
    );
    const rewritten = normalizeFromBase(sectionWithTiedNegative, baseWithTiedPositive, {
      critical: true,
      notice: false,
    });
    const positiveIdx = rewritten.indexOf('1000,500,4,2,1,50,1,0');
    const negativeIdx = rewritten.indexOf('1000,-50,4,2,1,50,0,0');
    expect(positiveIdx).toBeGreaterThanOrEqual(0);
    expect(negativeIdx).toBeGreaterThanOrEqual(0);
    expect(positiveIdx).toBeLessThan(negativeIdx);
  });

  it('TimingPoints normalization: section with no positives picks up base positives', () => {
    // The section has only an inherited (negative) timing point. After
    // critical normalization, the base's positive lines should be
    // inserted while the inherited point is kept.
    const sectionWithOnlyNegative = ACTIVE_BASE.replace(
      '[TimingPoints]\n0,500,4,2,1,50,1,0\n2000,333.33,4,2,1,50,1,0',
      '[TimingPoints]\n1000,-50,4,2,1,50,0,0',
    );
    const rewritten = normalizeFromBase(sectionWithOnlyNegative, ACTIVE_BASE, {
      critical: true,
      notice: false,
    });
    expect(rewritten).toContain('0,500,4,2,1,50,1,0');
    expect(rewritten).toContain('2000,333.33,4,2,1,50,1,0');
    expect(rewritten).toContain('1000,-50,4,2,1,50,0,0');
  });
});
