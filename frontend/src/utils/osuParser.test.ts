import { describe, it, expect } from 'vitest';
import {
  parseOsuFile,
  parseSections,
  parseTimingPoints,
  parseHitObjects,
  validateOsuFile,
  isPositiveTimingPoint,
  isNegativeTimingPoint,
  stringifySections,
  buildCandidateBase,
  parseBookmarks,
  bookmarksToSectionBoundaries,
  parseDifficultyName,
  parseMetadata,
  withMetadataVersion,
  sliceForSection,
  sanitizeSectionUpload,
} from './osuParser';

// ------------------------------------------------------------------
// Sample .osu fixtures
// ------------------------------------------------------------------

const VALID_OSU = `osu file format v14

[General]
AudioFilename: audio.mp3
AudioLeadIn: 0
PreviewTime: -1
Countdown: 1
SampleSet: Normal
StackLeniency: 0.7
Mode: 0
LetterboxInBreaks: 0
WidescreenStoryboard: 0

[Editor]
Bookmarks: 1000,2000,3000
DistanceSpacing: 1.2
BeatDivisor: 4
GridSize: 4
TimelineZoom: 1

[Metadata]
Title:Test Song
TitleUnicode:Test Song
Artist:Test Artist
ArtistUnicode:Test Artist
Creator:Mapper
Version:Easy
Source:
Tags:
BeatmapID:0
BeatmapSetID:-1

[Difficulty]
HPDrainRate:4
CircleSize:3
OverallDifficulty:3
ApproachRate:4
SliderMultiplier:1.4
SliderTickRate:1

[Events]
//Background and Video events
0,0,"bg.jpg",0,0
//Break Periods
//Storyboard Layer 0 (Background)

[TimingPoints]
0,500,4,2,1,50,1,0
1000,-100,4,2,1,50,0,0
2000,333.33,4,2,1,50,1,0

[Colours]
Combo1 : 255,0,0
Combo2 : 0,255,0

[HitObjects]
100,100,500,1,0
200,200,1000,1,0
300,300,1500,2,0,B|400:300|500:300,1,100
`;

const MISSING_HIT_OBJECTS = `osu file format v14

[General]
AudioFilename: audio.mp3

[TimingPoints]
0,500,4,2,1,50,1,0
`;

const EMPTY_FILE = '';

const MINIMAL_VALID = `osu file format v14

[HitObjects]
0,0,0,1,0
`;

const TIMING_POINTS_ONLY = `osu file format v14

[TimingPoints]
0,600,4,2,1,50,1,0
500,-50,4,2,1,50,0,0
1000,300,3,1,2,60,1,1
// comment line

1500,invalid,4,2,1,50,1,0
`;

const HIT_OBJECTS_ONLY = `osu file format v14

[HitObjects]
100,100,500,1,0
200,200,1000,1,0,0:0:0:0:
300,300,1500,2,0,B|400:300|500:300,1,100
// comment
400,400,2000,1,0

500,500
`;

// ------------------------------------------------------------------
// validateOsuFile
// ------------------------------------------------------------------

describe('validateOsuFile', () => {
  it('returns null for a valid file', () => {
    expect(validateOsuFile(VALID_OSU)).toBeNull();
  });

  it('returns error when [HitObjects] is missing', () => {
    const result = validateOsuFile(MISSING_HIT_OBJECTS);
    expect(result).toBe('Missing [HitObjects] section');
  });

  it('returns error for an empty file', () => {
    const result = validateOsuFile(EMPTY_FILE);
    expect(result).toBe('Missing [HitObjects] section');
  });

  it('returns null for a minimal valid file', () => {
    expect(validateOsuFile(MINIMAL_VALID)).toBeNull();
  });

  it('returns error when file exceeds 1 MB', () => {
    const huge = 'x'.repeat(1024 * 1024 + 1);
    const result = validateOsuFile(huge);
    expect(result).toContain('exceeds maximum allowed');
  });
});

// ------------------------------------------------------------------
// parseSections
// ------------------------------------------------------------------

describe('parseSections', () => {
  it('parses all bracket sections', () => {
    const sections = parseSections(VALID_OSU);
    const names = sections.map((s) => s.name);
    expect(names).toContain('General');
    expect(names).toContain('Metadata');
    expect(names).toContain('Difficulty');
    expect(names).toContain('TimingPoints');
    expect(names).toContain('HitObjects');
    expect(names).toContain('Editor');
    expect(names).toContain('Events');
    expect(names).toContain('Colours');
  });

  it('collects pre-section lines under empty name', () => {
    const sections = parseSections(VALID_OSU);
    const header = sections.find((s) => s.name === '');
    expect(header).toBeDefined();
    expect(header!.lines[0]).toBe('osu file format v14');
  });

  it('preserves blank lines and comments inside sections', () => {
    const sections = parseSections(VALID_OSU);
    const events = sections.find((s) => s.name === 'Events');
    expect(events).toBeDefined();
    expect(events!.lines.some((l) => l.startsWith('//'))).toBe(true);
  });

  it('handles files with no sections', () => {
    const sections = parseSections('just some text\nmore text');
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe('');
    expect(sections[0].lines).toEqual(['just some text', 'more text']);
  });
});

// ------------------------------------------------------------------
// parseTimingPoints
// ------------------------------------------------------------------

describe('parseTimingPoints', () => {
  it('extracts all valid timing points', () => {
    const lines = parseSections(TIMING_POINTS_ONLY).find((s) => s.name === 'TimingPoints')!.lines;
    const pts = parseTimingPoints(lines);
    expect(pts).toHaveLength(3);
  });

  it('parses numeric fields correctly', () => {
    const pts = parseTimingPoints(['0,500,4,2,1,50,1,0']);
    expect(pts[0]).toMatchObject({
      time: 0,
      beatLength: 500,
      meter: 4,
      sampleSet: 2,
      sampleIndex: 1,
      volume: 50,
      uninherited: 1,
      effects: 0,
    });
  });

  it('skips comments and blank lines', () => {
    const pts = parseTimingPoints(['', '// comment', '0,500,4,2,1,50,1,0']);
    expect(pts).toHaveLength(1);
  });

  it('skips malformed lines', () => {
    const pts = parseTimingPoints(['0,500,4,2,1,50,1,0', 'garbage', '']);
    expect(pts).toHaveLength(1);
  });

  it('defaults missing optional fields', () => {
    const pts = parseTimingPoints(['1000,300']);
    expect(pts[0]).toMatchObject({
      time: 1000,
      beatLength: 300,
      meter: 4,
      sampleSet: 0,
      sampleIndex: 0,
      volume: 0,
      uninherited: 1,
      effects: 0,
    });
  });

  it('preserves the raw line', () => {
    const raw = '0,500,4,2,1,50,1,0';
    const pts = parseTimingPoints([raw]);
    expect(pts[0].raw).toBe(raw);
  });
});

// ------------------------------------------------------------------
// parseHitObjects
// ------------------------------------------------------------------

describe('parseHitObjects', () => {
  it('extracts all valid hit objects', () => {
    const lines = parseSections(HIT_OBJECTS_ONLY).find((s) => s.name === 'HitObjects')!.lines;
    const objs = parseHitObjects(lines);
    expect(objs).toHaveLength(4);
  });

  it('parses circle correctly', () => {
    const objs = parseHitObjects(['100,100,500,1,0']);
    expect(objs[0]).toMatchObject({
      x: 100,
      y: 100,
      time: 500,
      type: 1,
      hitSound: 0,
      extras: '',
    });
  });

  it('parses slider with extras correctly', () => {
    const objs = parseHitObjects(['300,300,1500,2,0,B|400:300|500:300,1,100']);
    expect(objs[0]).toMatchObject({
      x: 300,
      y: 300,
      time: 1500,
      type: 2,
      hitSound: 0,
      extras: 'B|400:300|500:300,1,100',
    });
  });

  it('parses hit object with hitSample', () => {
    const objs = parseHitObjects(['200,200,1000,1,0,0:0:0:0:']);
    expect(objs[0].extras).toBe('0:0:0:0:');
  });

  it('skips comments and blank lines', () => {
    const objs = parseHitObjects(['// comment', '', '0,0,0,1,0']);
    expect(objs).toHaveLength(1);
  });

  it('skips malformed lines', () => {
    const objs = parseHitObjects(['0,0,0,1,0', 'bad', '1,2']);
    expect(objs).toHaveLength(1);
  });

  it('preserves the raw line', () => {
    const raw = '100,100,500,1,0';
    const objs = parseHitObjects([raw]);
    expect(objs[0].raw).toBe(raw);
  });
});

// ------------------------------------------------------------------
// parseOsuFile (integration)
// ------------------------------------------------------------------

describe('parseOsuFile', () => {
  it('returns structured data for a valid file', () => {
    const parsed = parseOsuFile(VALID_OSU);
    expect(parsed.sections.length).toBeGreaterThan(0);
    expect(parsed.timingPointsSection).not.toBeNull();
    expect(parsed.hitObjectsSection).not.toBeNull();
    expect(parsed.timingPoints.length).toBe(3);
    expect(parsed.hitObjects.length).toBe(3);
  });

  it('throws when [HitObjects] is missing', () => {
    expect(() => parseOsuFile(MISSING_HIT_OBJECTS)).toThrow('Missing [HitObjects] section');
  });

  it('throws when file exceeds 1 MB', () => {
    const huge = 'x'.repeat(1024 * 1024 + 1);
    expect(() => parseOsuFile(huge)).toThrow('exceeds maximum allowed');
  });

  it('sorts timing points by time ascending (implicit from parse order)', () => {
    const parsed = parseOsuFile(VALID_OSU);
    const times = parsed.timingPoints.map((tp) => tp.time);
    expect(times).toEqual([0, 1000, 2000]);
  });

  it('sorts hit objects by time ascending (implicit from parse order)', () => {
    const parsed = parseOsuFile(VALID_OSU);
    const times = parsed.hitObjects.map((ho) => ho.time);
    expect(times).toEqual([500, 1000, 1500]);
  });
});

// ------------------------------------------------------------------
// Timing point classification
// ------------------------------------------------------------------

describe('isPositiveTimingPoint', () => {
  it('returns true for uninherited (BPM) points', () => {
    expect(isPositiveTimingPoint({ beatLength: 500, uninherited: 1 } as any)).toBe(true);
  });

  it('returns true for positive beatLength even if uninherited flag is missing', () => {
    expect(isPositiveTimingPoint({ beatLength: 500, uninherited: 0 } as any)).toBe(true);
  });
});

describe('isNegativeTimingPoint', () => {
  it('returns true for inherited (SV) points', () => {
    expect(isNegativeTimingPoint({ beatLength: -100, uninherited: 0 } as any)).toBe(true);
  });

  it('returns true for negative beatLength even if uninherited flag is missing', () => {
    expect(isNegativeTimingPoint({ beatLength: -100, uninherited: 1 } as any)).toBe(true);
  });
});

// ------------------------------------------------------------------
// stringifySections
// ------------------------------------------------------------------

describe('stringifySections', () => {
  it('round-trips a parsed file', () => {
    const sections = parseSections(VALID_OSU);
    const reconstructed = stringifySections(sections);
    // Re-parsing should yield the same section names
    const reparsed = parseSections(reconstructed);
    expect(reparsed.map((s) => s.name)).toEqual(sections.map((s) => s.name));
  });

  it('produces bracket headers for named sections', () => {
    const result = stringifySections([{ name: 'General', lines: ['AudioFilename: test.mp3'] }]);
    expect(result).toContain('[General]');
    expect(result).toContain('AudioFilename: test.mp3');
  });
});

// ------------------------------------------------------------------
// buildCandidateBase
// ------------------------------------------------------------------

describe('buildCandidateBase', () => {
  it('produces a base with empty HitObjects', () => {
    const parsed = parseOsuFile(VALID_OSU);
    const base = buildCandidateBase(parsed);
    const baseParsed = parseSections(base);
    const hitObjects = baseParsed.find((s) => s.name === 'HitObjects');
    expect(hitObjects).toBeDefined();
    expect(hitObjects!.lines.length).toBeLessThanOrEqual(1);
  });

  it('filters out negative timing points', () => {
    const parsed = parseOsuFile(VALID_OSU);
    const base = buildCandidateBase(parsed);
    const baseParsed = parseSections(base);
    const tpLines = baseParsed.find((s) => s.name === 'TimingPoints')!.lines;
    const negative = tpLines.filter((l) => {
      const t = l.trim();
      if (t === '' || t.startsWith('//')) return false;
      const pts = parseTimingPoints([l]);
      return pts.length > 0 && isNegativeTimingPoint(pts[0]);
    });
    expect(negative).toHaveLength(0);
  });

  it('preserves positive timing points', () => {
    const parsed = parseOsuFile(VALID_OSU);
    const base = buildCandidateBase(parsed);
    const baseParsed = parseSections(base);
    const tpLines = baseParsed.find((s) => s.name === 'TimingPoints')!.lines;
    const positive = tpLines.filter((l) => {
      const t = l.trim();
      if (t === '' || t.startsWith('//')) return false;
      const pts = parseTimingPoints([l]);
      return pts.length > 0 && isPositiveTimingPoint(pts[0]);
    });
    expect(positive.length).toBeGreaterThan(0);
  });

  it('preserves headers before HitObjects', () => {
    const parsed = parseOsuFile(VALID_OSU);
    const base = buildCandidateBase(parsed);
    expect(base).toContain('[General]');
    expect(base).toContain('[Metadata]');
    expect(base).toContain('[Difficulty]');
    expect(base).toContain('osu file format v14');
  });
});

// ------------------------------------------------------------------
// parseBookmarks
// ------------------------------------------------------------------

describe('parseBookmarks', () => {
  it('returns bookmarks from [Editor] section', () => {
    const parsed = parseOsuFile(VALID_OSU);
    expect(parseBookmarks(parsed)).toEqual([1000, 2000, 3000]);
  });

  it('returns empty array when Editor section is missing', () => {
    const noEditor = VALID_OSU.replace(/\[Editor\][\s\S]*?\n\n/m, '');
    const parsed = parseOsuFile(noEditor);
    expect(parseBookmarks(parsed)).toEqual([]);
  });

  it('returns empty array when Bookmarks line is missing', () => {
    const noBookmarks = VALID_OSU.replace(/^Bookmarks:.*$/m, '');
    const parsed = parseOsuFile(noBookmarks);
    expect(parseBookmarks(parsed)).toEqual([]);
  });

  it('returns empty array for empty Bookmarks value', () => {
    const emptyBookmarks = VALID_OSU.replace(/^Bookmarks:.*$/m, 'Bookmarks:');
    const parsed = parseOsuFile(emptyBookmarks);
    expect(parseBookmarks(parsed)).toEqual([]);
  });

  it('sorts bookmarks ascending', () => {
    const osu = VALID_OSU.replace(/^Bookmarks:.*$/m, 'Bookmarks: 3000,1000,2000');
    const parsed = parseOsuFile(osu);
    expect(parseBookmarks(parsed)).toEqual([1000, 2000, 3000]);
  });

  it('filters out negative values', () => {
    const osu = VALID_OSU.replace(/^Bookmarks:.*$/m, 'Bookmarks: -100,500,1000');
    const parsed = parseOsuFile(osu);
    expect(parseBookmarks(parsed)).toEqual([500, 1000]);
  });
});

// ------------------------------------------------------------------
// bookmarksToSectionBoundaries
// ------------------------------------------------------------------

describe('bookmarksToSectionBoundaries', () => {
  it('returns empty array for empty bookmarks', () => {
    expect(bookmarksToSectionBoundaries([])).toEqual([]);
  });

  it('creates intro + inter sections when bookmarks start after 0', () => {
    const result = bookmarksToSectionBoundaries([5000, 30000]);
    expect(result).toEqual([
      { startMs: 0, endMs: 5000 },
      { startMs: 5000, endMs: 30000 },
    ]);
  });

  it('skips intro when first bookmark is at 0', () => {
    const result = bookmarksToSectionBoundaries([0, 10000, 20000]);
    expect(result).toEqual([
      { startMs: 0, endMs: 10000 },
      { startMs: 10000, endMs: 20000 },
    ]);
  });

  it('adds outro section when songLengthMs is provided', () => {
    const result = bookmarksToSectionBoundaries([5000, 30000], 60000);
    expect(result).toEqual([
      { startMs: 0, endMs: 5000 },
      { startMs: 5000, endMs: 30000 },
      { startMs: 30000, endMs: 60000 },
    ]);
  });

  it('does not add outro when last bookmark equals songLengthMs', () => {
    const result = bookmarksToSectionBoundaries([5000, 60000], 60000);
    expect(result).toEqual([
      { startMs: 0, endMs: 5000 },
      { startMs: 5000, endMs: 60000 },
    ]);
  });

  it('ignores duplicate bookmarks', () => {
    const result = bookmarksToSectionBoundaries([5000, 5000, 30000]);
    expect(result).toEqual([
      { startMs: 0, endMs: 5000 },
      { startMs: 5000, endMs: 30000 },
    ]);
  });

  it('handles a single bookmark with songLengthMs', () => {
    const result = bookmarksToSectionBoundaries([30000], 60000);
    expect(result).toEqual([
      { startMs: 0, endMs: 30000 },
      { startMs: 30000, endMs: 60000 },
    ]);
  });
});

// ------------------------------------------------------------------
// parseDifficultyName
// ------------------------------------------------------------------

describe('parseDifficultyName', () => {
  it('reads Version from [Metadata]', () => {
    const parsed = parseOsuFile(VALID_OSU);
    expect(parseDifficultyName(parsed)).toBe('Easy');
  });

  it('returns null when Metadata section is missing', () => {
    const noMeta = VALID_OSU.replace(/\[Metadata\][\s\S]*?\n\n/m, '');
    const parsed = parseOsuFile(noMeta);
    expect(parseDifficultyName(parsed)).toBeNull();
  });

  it('returns null when Version line is empty', () => {
    const emptyVersion = VALID_OSU.replace(/^Version:.*$/m, 'Version:');
    const parsed = parseOsuFile(emptyVersion);
    expect(parseDifficultyName(parsed)).toBeNull();
  });

  it('trims whitespace from Version value', () => {
    const padded = VALID_OSU.replace(/^Version:.*$/m, 'Version:   Insane Plus   ');
    const parsed = parseOsuFile(padded);
    expect(parseDifficultyName(parsed)).toBe('Insane Plus');
  });
});

// ------------------------------------------------------------------
// parseMetadata
// ------------------------------------------------------------------

describe('parseMetadata', () => {
  it('reads Artist, Title, and Version', () => {
    const parsed = parseOsuFile(VALID_OSU);
    expect(parseMetadata(parsed)).toEqual({
      artist: 'Test Artist',
      title: 'Test Song',
      version: 'Easy',
    });
  });

  it('returns null fields when [Metadata] is missing', () => {
    const noMeta = VALID_OSU.replace(/\[Metadata\][\s\S]*?\n\n/m, '');
    const parsed = parseOsuFile(noMeta);
    expect(parseMetadata(parsed)).toEqual({ artist: null, title: null, version: null });
  });
});

// ------------------------------------------------------------------
// withMetadataVersion
// ------------------------------------------------------------------

describe('withMetadataVersion', () => {
  it('replaces the existing Version line', () => {
    const parsed = parseOsuFile(VALID_OSU);
    const { content } = withMetadataVersion(parsed, 'Intro_version_2');
    const lines = content.split(/\r?\n/);
    expect(lines).toContain('Version:Intro_version_2');
    expect(lines).not.toContain('Version:Easy');
  });

  it('appends a Version line when none exists', () => {
    const noVersion = VALID_OSU.replace(/^Version:.*$/m, '');
    const parsed = parseOsuFile(noVersion);
    const { content } = withMetadataVersion(parsed, 'Base_version_1');
    expect(content.split(/\r?\n/)).toContain('Version:Base_version_1');
  });

  it('leaves other [Metadata] fields untouched', () => {
    const parsed = parseOsuFile(VALID_OSU);
    const { content } = withMetadataVersion(parsed, 'Anything');
    const lines = content.split(/\r?\n/);
    expect(lines).toContain('Title:Test Song');
    expect(lines).toContain('Artist:Test Artist');
    expect(lines).toContain('Creator:Mapper');
  });

  it('returns post-rewrite metadata in the same pass', () => {
    const parsed = parseOsuFile(VALID_OSU);
    const { metadata } = withMetadataVersion(parsed, 'Hard_version_5');
    expect(metadata).toEqual({
      artist: 'Test Artist',
      title: 'Test Song',
      version: 'Hard_version_5',
    });
  });
});

// ------------------------------------------------------------------
// sliceForSection
// ------------------------------------------------------------------

const SLICE_OSU = `osu file format v14

[General]
AudioFilename: audio.mp3

[Metadata]
Title:Test
Version:Hard

[TimingPoints]
0,500,4,1,0,100,1,0
1000,-100,4,1,0,80,0,0
2000,500,4,1,0,100,1,0
3000,-200,4,1,0,60,0,0

[HitObjects]
100,100,500,1,0,
200,200,1500,1,0,
300,300,2500,1,0,
400,400,3500,1,0,
`;

describe('sliceForSection', () => {
  it('keeps only timing points and hit objects within [startMs, endMs)', () => {
    const parsed = parseOsuFile(SLICE_OSU);
    const sliced = sliceForSection(parsed, 1000, 3000);
    // Compare full lines — substring checks collide (e.g. "2000,500,…" ⊃ "0,500,…").
    const lines = sliced.split(/\r?\n/);

    // TimingPoints at 1000 and 2000 should remain; 0 and 3000 should not.
    expect(lines).toContain('1000,-100,4,1,0,80,0,0');
    expect(lines).toContain('2000,500,4,1,0,100,1,0');
    expect(lines).not.toContain('0,500,4,1,0,100,1,0');
    expect(lines).not.toContain('3000,-200,4,1,0,60,0,0');

    // HitObjects: 1500 and 2500 stay; 500 and 3500 do not.
    expect(lines).toContain('200,200,1500,1,0,');
    expect(lines).toContain('300,300,2500,1,0,');
    expect(lines).not.toContain('100,100,500,1,0,');
    expect(lines).not.toContain('400,400,3500,1,0,');
  });

  it('treats the end timestamp as exclusive', () => {
    const parsed = parseOsuFile(SLICE_OSU);
    const sliced = sliceForSection(parsed, 0, 2000);
    // Hit object at exactly 2000 would be excluded; here we just verify 1500 in and 2500 out.
    expect(sliced).toContain(',1500,');
    expect(sliced).not.toContain(',2500,');
  });

  it('preserves headers like [General] and [Metadata]', () => {
    const parsed = parseOsuFile(SLICE_OSU);
    const sliced = sliceForSection(parsed, 0, 5000);
    expect(sliced).toContain('[General]');
    expect(sliced).toContain('[Metadata]');
    expect(sliced).toContain('Version:Hard');
  });

  it('produces empty TimingPoints and HitObjects sections when the range is empty', () => {
    const parsed = parseOsuFile(SLICE_OSU);
    const sliced = sliceForSection(parsed, 10000, 20000);
    // Should still be a parseable .osu with the expected sections.
    expect(sliced).toContain('[TimingPoints]');
    expect(sliced).toContain('[HitObjects]');
    expect(sliced).not.toContain('1000,-100,');
    expect(sliced).not.toContain(',1500,');
  });
});

// ------------------------------------------------------------------
// sanitizeSectionUpload
// ------------------------------------------------------------------

const SANITIZE_OSU = `osu file format v14

[General]
AudioFilename: audio.mp3

[Editor]
Bookmarks: 0,1000,2000,3000

[Metadata]
Title:Test
Artist:A
Version:Hard

[Events]
0,0,"bg.jpg",0,0
2,500,800
2,1200,1500
2,1800,2500
2,2800,2900

[TimingPoints]
500,500,4,1,0,100,1,0
1500,-100,4,1,0,80,0,0
2000,-50,4,1,0,80,0,0
2500,-200,4,1,0,80,0,0

[HitObjects]
100,100,500,1,0,
100,100,1500,1,0,
100,100,1999,1,0,
100,100,2000,1,0,
100,100,2500,1,0,
`;

describe('sanitizeSectionUpload', () => {
  it('keeps content inside [startMs, endMs) and reports drop counts', () => {
    const parsed = parseOsuFile(SANITIZE_OSU);
    const result = sanitizeSectionUpload(parsed, 1000, 2000);

    // Drops: hit objects at 500, 2000, 2500 → 3.
    //        timing points at 500, 2000, 2500 → 3.
    //        breaks (500,800), (1800,2500), (2800,2900) → 3
    //        kept break: (1200,1500).
    expect(result.dropped.hitObjects).toBe(3);
    expect(result.dropped.timingPoints).toBe(3);
    expect(result.dropped.breaks).toBe(3);
    expect(result.changed).toBe(true);

    const lines = result.content.split(/\r?\n/);
    // Hit objects: 1500 and 1999 stay; 500, 2000, 2500 dropped.
    expect(lines).toContain('100,100,1500,1,0,');
    expect(lines).toContain('100,100,1999,1,0,');
    expect(lines).not.toContain('100,100,500,1,0,');
    expect(lines).not.toContain('100,100,2000,1,0,');
    expect(lines).not.toContain('100,100,2500,1,0,');
    // Timing points: 1500 stays; 500, 2000, 2500 dropped.
    expect(lines).toContain('1500,-100,4,1,0,80,0,0');
    expect(lines).not.toContain('500,500,4,1,0,100,1,0');
    expect(lines).not.toContain('2000,-50,4,1,0,80,0,0');
    expect(lines).not.toContain('2500,-200,4,1,0,80,0,0');
    // Breaks: only (1200,1500) is fully inside [1000,2000); end exclusive.
    expect(lines).toContain('2,1200,1500');
    expect(lines).not.toContain('2,500,800');
    expect(lines).not.toContain('2,1800,2500');
    expect(lines).not.toContain('2,2800,2900');
    // Non-break events preserved.
    expect(lines).toContain('0,0,"bg.jpg",0,0');
  });

  it('drops content exactly at endMs (belongs to the next section)', () => {
    const parsed = parseOsuFile(SANITIZE_OSU);
    const result = sanitizeSectionUpload(parsed, 1000, 2000);
    // 2000 is the next section's start; must not appear in this section.
    const lines = result.content.split(/\r?\n/);
    expect(lines).not.toContain('100,100,2000,1,0,');
    expect(lines).not.toContain('2000,-50,4,1,0,80,0,0');
  });

  it('reports no changes when everything is inside the range', () => {
    const parsed = parseOsuFile(SANITIZE_OSU);
    const result = sanitizeSectionUpload(parsed, 0, 5000);
    expect(result.changed).toBe(false);
    expect(result.dropped).toEqual({ hitObjects: 0, timingPoints: 0, breaks: 0 });
  });
});
