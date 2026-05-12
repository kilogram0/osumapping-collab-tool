import { describe, it, expect } from 'vitest';
import { diffBase, normalizeCriticalLines } from './osuBase';

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
    expect(report.timingPointsChanged).toBe(false);
    expect(report.hasDiff).toBe(false);
  });

  it('detects a critical [Difficulty] change', () => {
    const candidate = ACTIVE_BASE.replace('HPDrainRate:4', 'HPDrainRate:5');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toContain('Difficulty:HPDrainRate');
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

  it('detects a critical AudioFilename change', () => {
    const candidate = ACTIVE_BASE.replace('AudioFilename: audio.mp3', 'AudioFilename: new.ogg');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toContain('General:AudioFilename');
    expect(report.hasDiff).toBe(true);
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
    expect(report.critical).toEqual([]);
    expect(report.hasDiff).toBe(true);
  });

  it('detects a notice [Metadata] change', () => {
    const candidate = ACTIVE_BASE.replace('Artist:Test Artist', 'Artist:Another Artist');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.notice).toContain('Metadata:Artist');
    expect(report.critical).toEqual([]);
  });

  it('ignores [Metadata] Version changes', () => {
    const candidate = ACTIVE_BASE.replace('Version:Easy', 'Version:Hard');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toEqual([]);
    expect(report.notice).toEqual([]);
    expect(report.hasDiff).toBe(false);
  });

  it('detects [Events] changes as notice', () => {
    const candidate = ACTIVE_BASE.replace('2,1000,2000', '2,1000,3000');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.notice).toContain('Events');
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

  it('detects [TimingPoints] changes as notice + timingPointsChanged', () => {
    const candidate = ACTIVE_BASE.replace(
      '0,500,4,2,1,50,1,0',
      '0,600,4,2,1,50,1,0',
    );
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.timingPointsChanged).toBe(true);
    expect(report.notice).toContain('TimingPoints');
    expect(report.critical).toEqual([]);
  });

  it('ignores [TimingPoints] blank-line changes', () => {
    const candidate = ACTIVE_BASE.replace(
      '[TimingPoints]\n0,500,4,2,1,50,1,0',
      '[TimingPoints]\n\n0,500,4,2,1,50,1,0',
    );
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.timingPointsChanged).toBe(false);
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
  });

  it('detects removed keys in candidate', () => {
    const candidate = ACTIVE_BASE.replace('HPDrainRate:4\n', '');
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.critical).toContain('Difficulty:HPDrainRate');
  });

  it('detects event line additions', () => {
    const candidate = ACTIVE_BASE.replace(
      '2,1000,2000',
      '2,1000,2000\n2,3000,4000',
    );
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.notice).toContain('Events');
  });

  it('detects timing point additions', () => {
    const candidate = ACTIVE_BASE.replace(
      '2000,333.33,4,2,1,50,1,0',
      '2000,333.33,4,2,1,50,1,0\n4000,250,4,2,1,50,1,0',
    );
    const report = diffBase(candidate, ACTIVE_BASE);
    expect(report.timingPointsChanged).toBe(true);
    expect(report.notice).toContain('TimingPoints');
  });
});

// ------------------------------------------------------------------
// normalizeCriticalLines
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

  it('preserves non-critical [General] lines', () => {
    const section = ACTIVE_BASE.replace('PreviewTime: -1', 'PreviewTime: 9999');
    const rewritten = normalizeCriticalLines(section, ACTIVE_BASE);
    expect(rewritten).toContain('PreviewTime: 9999');
  });

  it('preserves [Metadata] Version lines', () => {
    const section = ACTIVE_BASE.replace('Version:Easy', 'Version:Hard');
    const rewritten = normalizeCriticalLines(section, ACTIVE_BASE);
    expect(rewritten).toContain('Version:Hard');
  });

  it('preserves [Events] lines', () => {
    const section = ACTIVE_BASE.replace('2,1000,2000', '2,1000,9999');
    const rewritten = normalizeCriticalLines(section, ACTIVE_BASE);
    expect(rewritten).toContain('2,1000,9999');
  });

  it('preserves [TimingPoints] lines', () => {
    const section = ACTIVE_BASE.replace('0,500,4,2,1,50,1,0', '0,999,4,2,1,50,1,0');
    const rewritten = normalizeCriticalLines(section, ACTIVE_BASE);
    expect(rewritten).toContain('0,999,4,2,1,50,1,0');
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
    // The key was removed; normalizeCriticalLines only rewrites existing lines.
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
