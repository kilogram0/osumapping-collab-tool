import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseOszFile } from './oszParser';

// jsdom does not implement Blob/File.arrayBuffer(); polyfill via FileReader
// so parseOszFile (which calls file.arrayBuffer()) works in the test environment.
beforeAll(() => {
  if (!Blob.prototype.arrayBuffer) {
    Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    };
  }
});

// Minimal valid .osu content; parseOsuFile requires [HitObjects].
function makeOsu(version: string, artist: string, title: string, audioFile: string, bookmarks: string): string {
  return `osu file format v14\n\n[General]\nAudioFilename: ${audioFile}\n\n[Metadata]\nTitle:${title}\nArtist:${artist}\nVersion:${version}\n\n[Editor]\nBookmarks: ${bookmarks}\n\n[HitObjects]\n256,192,5000,1,0,0:0:0:0:\n`;
}

const AUDIO_DURATION_S = 187.5;
const MOCK_AUDIO_CONTEXT = {
  decodeAudioData: vi.fn().mockResolvedValue({ duration: AUDIO_DURATION_S }),
  close: vi.fn().mockResolvedValue(undefined),
};

beforeEach(() => {
  vi.stubGlobal('AudioContext', vi.fn(() => MOCK_AUDIO_CONTEXT));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('parseOszFile', () => {
  it('extracts difficulties, metadata, audioFilename, and song length', async () => {
    const osu = makeOsu('Hard', 'Test Artist', 'Test Song', 'audio.mp3', '5000,15000,25000');
    const bytes = zipSync({
      'Test Artist - Test Song [Hard].osu': strToU8(osu),
      'audio.mp3': new Uint8Array(8),
    });
    const file = new File([bytes], 'test.osz');

    const result = await parseOszFile(file);

    expect(result.difficulties).toHaveLength(1);
    expect(result.difficulties[0].name).toBe('Hard');
    expect(result.difficulties[0].bookmarks).toEqual([5000, 15000, 25000]);
    expect(result.title).toBe('Test Song');
    expect(result.artist).toBe('Test Artist');
    expect(result.audioFilename).toBe('audio.mp3');
    expect(result.songLengthMs).toBe(Math.round(AUDIO_DURATION_S * 1000));
  });

  it('sorts difficulties by filename (code-point order, not locale)', async () => {
    const bytes = zipSync({
      'z_diff.osu': strToU8(makeOsu('Normal', 'A', 'S', 'audio.mp3', '')),
      'a_diff.osu': strToU8(makeOsu('Hard', 'A', 'S', 'audio.mp3', '')),
      'audio.mp3': new Uint8Array(8),
    });
    const file = new File([bytes], 'test.osz');

    const result = await parseOszFile(file);

    expect(result.difficulties[0].filename).toBe('a_diff.osu');
    expect(result.difficulties[1].filename).toBe('z_diff.osu');
  });

  it('handles multiple .osu files and skips non-.osu entries', async () => {
    const bytes = zipSync({
      'map [Easy].osu': strToU8(makeOsu('Easy', 'X', 'Y', 'audio.ogg', '1000,2000')),
      'map [Insane].osu': strToU8(makeOsu('Insane', 'X', 'Y', 'audio.ogg', '1000,2000')),
      'audio.ogg': new Uint8Array(8),
      'background.jpg': new Uint8Array(4),
    });

    const result = await parseOszFile(new File([bytes], 'multi.osz'));

    expect(result.difficulties).toHaveLength(2);
    expect(result.audioFilename).toBe('audio.ogg');
  });

  it('returns songLengthMs null when audio decoding fails', async () => {
    MOCK_AUDIO_CONTEXT.decodeAudioData.mockRejectedValueOnce(new Error('decode failed'));

    const bytes = zipSync({
      'diff.osu': strToU8(makeOsu('Normal', 'A', 'B', 'audio.mp3', '1000')),
      'audio.mp3': new Uint8Array(8),
    });

    const result = await parseOszFile(new File([bytes], 'bad-audio.osz'));

    expect(result.songLengthMs).toBeNull();
    expect(result.difficulties).toHaveLength(1);
  });

  it('throws on a corrupt (non-zip) file', async () => {
    const file = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], 'bad.osz');

    await expect(parseOszFile(file)).rejects.toThrow(/Failed to read .osz/);
  });

  it('returns empty difficulties array when archive has no .osu files', async () => {
    const bytes = zipSync({ 'audio.mp3': new Uint8Array(8) });

    const result = await parseOszFile(new File([bytes], 'no-osu.osz'));

    expect(result.difficulties).toHaveLength(0);
  });
});
