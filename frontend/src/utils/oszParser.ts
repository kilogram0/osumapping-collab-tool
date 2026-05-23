/**
 * .osz archive parser.
 *
 * A .osz is a standard ZIP file containing one or more .osu difficulty files
 * plus an audio file (and optional assets). Everything is parsed client-side;
 * the archive is never uploaded.
 */

import { unzip, strFromU8 } from 'fflate';
import {
  parseOsuFile,
  parseDifficultyName,
  parseBookmarks,
  parseMetadata,
  type ParsedOsuFile,
} from './osuParser';

export const MAX_OSZ_BYTES = 100 * 1024 * 1024; // 100 MB

export interface OszDifficulty {
  filename: string;
  content: string;
  parsed: ParsedOsuFile;
  name: string | null;
  bookmarks: number[];
}

export interface ParsedOsz {
  difficulties: OszDifficulty[];
  title: string | null;
  artist: string | null;
  audioFilename: string | null;
  /** Duration decoded from the audio file, or null if decoding failed. */
  songLengthMs: number | null;
}

const AUDIO_EXTENSIONS = ['.mp3', '.ogg', '.wav', '.flac'];

function parseAudioFilename(parsed: ParsedOsuFile): string | null {
  const general = parsed.sections.find((s) => s.name === 'General');
  if (!general) return null;
  for (const line of general.lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('AudioFilename:')) {
      return trimmed.slice('AudioFilename:'.length).trim() || null;
    }
  }
  return null;
}

export async function parseOszFile(file: File): Promise<ParsedOsz> {
  if (file.size > MAX_OSZ_BYTES) {
    throw new Error(
      `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB; max ${MAX_OSZ_BYTES / 1024 / 1024} MB).`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(bytes, (err, data) => {
      if (err)
        reject(
          new Error(
            `Failed to read .osz file: ${err.message}. Make sure it is a valid .osz archive.`,
          ),
        );
      else resolve(data);
    });
  });

  const osuEntries: { filename: string; data: Uint8Array }[] = [];
  const audioEntries: Record<string, Uint8Array> = {}; // keyed by lowercase filename

  for (const [filename, data] of Object.entries(entries)) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.osu')) {
      osuEntries.push({ filename, data });
    } else if (AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      audioEntries[lower] = data;
    }
  }

  const difficulties: OszDifficulty[] = [];
  let audioFilename: string | null = null;

  for (const { filename, data } of osuEntries) {
    try {
      const text = strFromU8(data);
      const parsed = parseOsuFile(text);
      const name = parseDifficultyName(parsed);
      const bookmarks = parseBookmarks(parsed);

      if (!audioFilename) {
        audioFilename = parseAudioFilename(parsed);
      }

      difficulties.push({ filename, content: text, parsed, name, bookmarks });
    } catch {
      // skip malformed .osu files
    }
  }

  difficulties.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));

  const firstDiff = difficulties[0];
  const metadata = firstDiff ? parseMetadata(firstDiff.parsed) : null;

  let songLengthMs: number | null = null;
  if (audioFilename) {
    const audioBytes = audioEntries[audioFilename.toLowerCase()];
    if (audioBytes) {
      songLengthMs = await getAudioDurationMs(audioBytes);
    }
  }

  return {
    difficulties,
    title: metadata?.title ?? null,
    artist: metadata?.artist ?? null,
    audioFilename,
    songLengthMs,
  };
}

export async function getAudioDurationMs(bytes: Uint8Array): Promise<number | null> {
  try {
    // Blob.arrayBuffer() yields a plain ArrayBuffer regardless of the Uint8Array's
    // byteOffset or the underlying buffer type — no cast needed.
    const arrayBuffer = await new Blob([bytes as Uint8Array<ArrayBuffer>]).arrayBuffer();
    const audioContext = new AudioContext();
    try {
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      return Math.round(audioBuffer.duration * 1000);
    } finally {
      await audioContext.close();
    }
  } catch {
    return null;
  }
}
