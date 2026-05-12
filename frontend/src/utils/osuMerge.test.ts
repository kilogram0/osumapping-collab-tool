import { describe, it, expect } from 'vitest';
import { mergeOsu } from './osuMerge';

// ------------------------------------------------------------------
// Fixture helpers
// ------------------------------------------------------------------

function makeBase(extraTiming = ''): string {
  return `osu file format v14

[General]
AudioFilename: audio.mp3

[Metadata]
Title:Test Song
Version:Easy

[Difficulty]
HPDrainRate:4
CircleSize:3

[TimingPoints]
0,500,4,2,1,50,1,0${extraTiming}

[HitObjects]
`;
}

function makeSection(opts: {
  timingPoints?: string[];
  hitObjects?: string[];
}): string {
  const tp = opts.timingPoints?.join('\n') ?? '';
  const ho = opts.hitObjects?.join('\n') ?? '';
  return `osu file format v14

[General]
AudioFilename: audio.mp3

[TimingPoints]
${tp}

[HitObjects]
${ho}
`;
}

// ------------------------------------------------------------------
// mergeOsu
// ------------------------------------------------------------------

describe('mergeOsu', () => {
  it('preserves base headers and appends empty HitObjects when no sections', () => {
    const merged = mergeOsu(makeBase(), []);
    expect(merged).toContain('[General]');
    expect(merged).toContain('AudioFilename: audio.mp3');
    expect(merged).toContain('[Metadata]');
    expect(merged).toContain('[Difficulty]');
    expect(merged).toContain('[TimingPoints]');
    expect(merged).toContain('[HitObjects]');
  });

  it('merges a single section timing point and hit object', () => {
    const section = makeSection({
      timingPoints: ['1000,-100,4,2,1,50,0,0'],
      hitObjects: ['100,100,1000,1,0'],
    });
    const merged = mergeOsu(makeBase(), [
      { content: section, sortOrder: 0, sectionId: 's1' },
    ]);
    expect(merged).toContain('0,500,4,2,1,50,1,0');
    expect(merged).toContain('1000,-100,4,2,1,50,0,0');
    expect(merged).toContain('100,100,1000,1,0');
  });

  it('sorts hit objects by time ascending', () => {
    const section = makeSection({
      hitObjects: ['300,300,2000,1,0', '100,100,500,1,0', '200,200,1500,1,0'],
    });
    const merged = mergeOsu(makeBase(), [
      { content: section, sortOrder: 0, sectionId: 's1' },
    ]);
    const hoIdx = merged.indexOf('[HitObjects]');
    const hoPart = merged.slice(hoIdx);
    const lines = hoPart.split('\n').slice(1).filter((l) => l.trim() !== '');
    expect(lines[0]).toBe('100,100,500,1,0');
    expect(lines[1]).toBe('200,200,1500,1,0');
    expect(lines[2]).toBe('300,300,2000,1,0');
  });

  it('sorts timing points by time ascending', () => {
    const section = makeSection({
      timingPoints: [
        '3000,-50,4,2,1,50,0,0',
        '1000,-100,4,2,1,50,0,0',
        '2000,400,4,2,1,50,1,0',
      ],
    });
    const merged = mergeOsu(makeBase(), [
      { content: section, sortOrder: 0, sectionId: 's1' },
    ]);
    const tpIdx = merged.indexOf('[TimingPoints]');
    const hoIdx = merged.indexOf('[HitObjects]');
    const tpPart = merged.slice(tpIdx, hoIdx);
    const lines = tpPart.split('\n').slice(1).filter((l) => l.trim() !== '');
    expect(lines[0]).toBe('0,500,4,2,1,50,1,0');
    expect(lines[1]).toBe('1000,-100,4,2,1,50,0,0');
    expect(lines[2]).toBe('2000,400,4,2,1,50,1,0');
    expect(lines[3]).toBe('3000,-50,4,2,1,50,0,0');
  });

  it('deduplicates positive timing points at same timestamp', () => {
    const base = makeBase('\n1000,500,4,2,1,50,1,0');
    const section = makeSection({
      timingPoints: ['1000,600,4,2,1,50,1,0'],
    });
    const merged = mergeOsu(base, [
      { content: section, sortOrder: 0, sectionId: 's1' },
    ]);
    const tpIdx = merged.indexOf('[TimingPoints]');
    const hoIdx = merged.indexOf('[HitObjects]');
    const tpPart = merged.slice(tpIdx, hoIdx);
    const lines = tpPart
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '' && !l.startsWith('0,'));
    expect(lines).toHaveLength(1);
    // Section should win over base
    expect(lines[0]).toBe('1000,600,4,2,1,50,1,0');
  });

  it('preserves one positive + one negative at the same timestamp', () => {
    const section = makeSection({
      timingPoints: [
        '1000,500,4,2,1,50,1,0',
        '1000,-100,4,2,1,50,0,0',
      ],
    });
    const merged = mergeOsu(makeBase(), [
      { content: section, sortOrder: 0, sectionId: 's1' },
    ]);
    const tpIdx = merged.indexOf('[TimingPoints]');
    const hoIdx = merged.indexOf('[HitObjects]');
    const tpPart = merged.slice(tpIdx, hoIdx);
    const lines = tpPart
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '' && l.includes('1000'));
    expect(lines).toHaveLength(2);
  });

  it('tiebreaks by lower sort_order among sections', () => {
    const base = makeBase('\n1000,500,4,2,1,50,1,0');
    const sectionA = makeSection({
      timingPoints: ['1000,600,4,2,1,50,1,0'],
    });
    const sectionB = makeSection({
      timingPoints: ['1000,700,4,2,1,50,1,0'],
    });
    const merged = mergeOsu(base, [
      { content: sectionA, sortOrder: 1, sectionId: 'sA' },
      { content: sectionB, sortOrder: 0, sectionId: 'sB' },
    ]);
    const tpIdx = merged.indexOf('[TimingPoints]');
    const hoIdx = merged.indexOf('[HitObjects]');
    const tpPart = merged.slice(tpIdx, hoIdx);
    const lines = tpPart
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '' && l.includes('1000'));
    expect(lines).toHaveLength(1);
    // Section B has lower sort_order (0 < 1) so it wins
    expect(lines[0]).toBe('1000,700,4,2,1,50,1,0');
  });

  it('uses sectionId as stable secondary tiebreaker when sort_order is equal', () => {
    const base = makeBase('\n1000,500,4,2,1,50,1,0');
    const sectionA = makeSection({
      timingPoints: ['1000,600,4,2,1,50,1,0'],
    });
    const sectionB = makeSection({
      timingPoints: ['1000,700,4,2,1,50,1,0'],
    });
    const merged = mergeOsu(base, [
      { content: sectionA, sortOrder: 0, sectionId: 'sB' },
      { content: sectionB, sortOrder: 0, sectionId: 'sA' },
    ]);
    const tpIdx = merged.indexOf('[TimingPoints]');
    const hoIdx = merged.indexOf('[HitObjects]');
    const tpPart = merged.slice(tpIdx, hoIdx);
    const lines = tpPart
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '' && l.includes('1000'));
    expect(lines).toHaveLength(1);
    // sA < sB lexicographically, so section B (with id sA) wins
    expect(lines[0]).toBe('1000,700,4,2,1,50,1,0');
  });

  it('merges hit objects from multiple sections', () => {
    const sectionA = makeSection({
      hitObjects: ['100,100,500,1,0', '200,200,1500,1,0'],
    });
    const sectionB = makeSection({
      hitObjects: ['150,150,1000,1,0', '250,250,2000,1,0'],
    });
    const merged = mergeOsu(makeBase(), [
      { content: sectionA, sortOrder: 0, sectionId: 'sA' },
      { content: sectionB, sortOrder: 1, sectionId: 'sB' },
    ]);
    const tpIdx = merged.indexOf('[HitObjects]');
    const lines = merged
      .slice(tpIdx)
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('100,100,500,1,0');
    expect(lines[1]).toBe('150,150,1000,1,0');
    expect(lines[2]).toBe('200,200,1500,1,0');
    expect(lines[3]).toBe('250,250,2000,1,0');
  });

  it('handles sections without timing points or hit objects', () => {
    const section = makeSection({});
    const merged = mergeOsu(makeBase(), [
      { content: section, sortOrder: 0, sectionId: 's1' },
    ]);
    expect(merged).toContain('[TimingPoints]');
    expect(merged).toContain('[HitObjects]');
  });

  it('filters base negative timing points (only positive from base)', () => {
    const base = makeBase('\n1000,-100,4,2,1,50,0,0');
    const merged = mergeOsu(base, []);
    const tpIdx = merged.indexOf('[TimingPoints]');
    const hoIdx = merged.indexOf('[HitObjects]');
    const tpPart = merged.slice(tpIdx, hoIdx);
    const lines = tpPart
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '');
    // Should NOT contain the negative base timing point
    expect(lines.some((l) => l.includes('-100'))).toBe(false);
    expect(lines).toHaveLength(1);
  });

  it('allows negative timing points from sections even when base has none', () => {
    const section = makeSection({
      timingPoints: ['1000,-100,4,2,1,50,0,0'],
    });
    const merged = mergeOsu(makeBase(), [
      { content: section, sortOrder: 0, sectionId: 's1' },
    ]);
    const tpIdx = merged.indexOf('[TimingPoints]');
    const hoIdx = merged.indexOf('[HitObjects]');
    const tpPart = merged.slice(tpIdx, hoIdx);
    const lines = tpPart
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '' && l.includes('1000'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('1000,-100,4,2,1,50,0,0');
  });

  it('preserves base Editor and Colours sections', () => {
    const base = `osu file format v14

[Editor]
Bookmarks: 1000,2000
DistanceSpacing: 1.2

[Colours]
Combo1 : 255,0,0

[TimingPoints]
0,500,4,2,1,50,1,0

[HitObjects]
`;
    const merged = mergeOsu(base, []);
    expect(merged).toContain('[Editor]');
    expect(merged).toContain('Bookmarks: 1000,2000');
    expect(merged).toContain('[Colours]');
    expect(merged).toContain('Combo1 : 255,0,0');
  });

  it('outputs positive timing points before negative at same timestamp', () => {
    const section = makeSection({
      timingPoints: [
        '1000,-100,4,2,1,50,0,0',
        '1000,500,4,2,1,50,1,0',
      ],
    });
    const merged = mergeOsu(makeBase(), [
      { content: section, sortOrder: 0, sectionId: 's1' },
    ]);
    const tpIdx = merged.indexOf('[TimingPoints]');
    const hoIdx = merged.indexOf('[HitObjects]');
    const tpPart = merged.slice(tpIdx, hoIdx);
    const lines = tpPart
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '' && l.includes('1000'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('500');
    expect(lines[1]).toContain('-100');
  });

  it('deduplicates negative timing points at same timestamp across sections', () => {
    const sectionA = makeSection({
      timingPoints: ['1000,-100,4,2,1,50,0,0'],
    });
    const sectionB = makeSection({
      timingPoints: ['1000,-200,4,2,1,50,0,0'],
    });
    const merged = mergeOsu(makeBase(), [
      { content: sectionA, sortOrder: 1, sectionId: 'sA' },
      { content: sectionB, sortOrder: 0, sectionId: 'sB' },
    ]);
    const tpIdx = merged.indexOf('[TimingPoints]');
    const hoIdx = merged.indexOf('[HitObjects]');
    const tpPart = merged.slice(tpIdx, hoIdx);
    const lines = tpPart
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '' && l.includes('1000') && l.startsWith('1000,-'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('1000,-200,4,2,1,50,0,0');
  });

  it('does not deduplicate hit objects at the same timestamp', () => {
    const section = makeSection({
      hitObjects: ['100,100,500,1,0', '200,200,500,1,0'],
    });
    const merged = mergeOsu(makeBase(), [
      { content: section, sortOrder: 0, sectionId: 's1' },
    ]);
    const tpIdx = merged.indexOf('[HitObjects]');
    const lines = merged
      .slice(tpIdx)
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(2);
  });

  it('handles real-world .osu with simultaneous positive+negative timing points', () => {
    // This mirrors the user's provided file where 83371 has both:
    // 83371,506.7749,4,1,2,66,1,8  (positive)
    // 83371,-54.5058142125141,4,1,2,66,0,8 (negative)
    const base = `osu file format v128

[General]
AudioFilename: audio.ogg

[TimingPoints]
36900,500,4,2,1,54,1,0

[HitObjects]
`;
    const section = makeSection({
      timingPoints: [
        '83371,506.7749,4,1,2,66,1,8',
        '83371,-54.5058142125141,4,1,2,66,0,8',
      ],
      hitObjects: ['0,258,4877,5,2,2:0:0:0:'],
    });
    const merged = mergeOsu(base, [
      { content: section, sortOrder: 0, sectionId: 's1' },
    ]);
    expect(merged).toContain('83371,506.7749,4,1,2,66,1,8');
    expect(merged).toContain('83371,-54.5058142125141,4,1,2,66,0,8');

    // Verify order: positive before negative at same time
    const tpIdx = merged.indexOf('[TimingPoints]');
    const hoIdx = merged.indexOf('[HitObjects]');
    const tpPart = merged.slice(tpIdx, hoIdx);
    const posIdx = tpPart.indexOf('83371,506.7749');
    const negIdx = tpPart.indexOf('83371,-54.505');
    expect(posIdx).toBeLessThan(negIdx);
  });
});
