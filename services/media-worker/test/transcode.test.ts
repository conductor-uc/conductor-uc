import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TranscodeError, transcodeToWav } from '../src/transcode.js';
import { ffmpegOrSkipReason } from './ffmpeg-availability.js';

const execFileAsync = promisify(execFile);
const skipReason = await ffmpegOrSkipReason();
const PATHS = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' };

/** Reads a WAV header's sample rate/channel count directly — `ffprobe` on the *output* is the independent check that what `transcodeToWav` claims to have produced is what actually landed on disk. */
function readWavFormat(buffer: Buffer): { sampleRate: number; channels: number } {
  // A canonical WAV `fmt ` chunk starts at byte 12 and is at least 16 bytes:
  // channels (u16 @ 22), sample rate (u32 @ 24) — confirmed directly against
  // ffmpeg's own `-f wav` output rather than assumed from the spec alone.
  return { channels: buffer.readUInt16LE(22), sampleRate: buffer.readUInt32LE(24) };
}

describe.skipIf(skipReason !== undefined)('transcodeToWav', () => {
  let workDir: string;
  let toneMp3: Buffer;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'transcode-test-'));
    const tonePath = path.join(workDir, 'tone.mp3');
    // A real, deterministic 1s 440Hz mono tone — synthesized, not a checked-in
    // binary fixture, so this test needs nothing beyond `ffmpeg` itself.
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-codec:a',
      'libmp3lame',
      tonePath,
    ]);
    toneMp3 = await readFile(tonePath);
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('produces real 8kHz and 16kHz mono WAV files with the correct duration and a stable sha256', async () => {
    const result = await transcodeToWav(toneMp3, PATHS);

    expect(result.durationMs).toBeGreaterThanOrEqual(900);
    expect(result.durationMs).toBeLessThanOrEqual(1100);
    expect(result.sizeBytes).toBe(toneMp3.length);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(readWavFormat(result.wav8k)).toEqual({ sampleRate: 8000, channels: 1 });
    expect(readWavFormat(result.wav16k)).toEqual({ sampleRate: 16000, channels: 1 });

    // sha256 is of the *raw input*, not incidentally a hash of one of the
    // outputs — re-running against the same bytes must reproduce it exactly.
    const again = await transcodeToWav(toneMp3, PATHS);
    expect(again.sha256).toBe(result.sha256);
  });

  it('rejects bytes that are not real audio at all', async () => {
    const notAudio = Buffer.from('this is definitely not an mp3 file, just text');
    await expect(transcodeToWav(notAudio, PATHS)).rejects.toThrow(TranscodeError);
  });

  it('fails clearly when the configured ffmpeg binary does not exist', async () => {
    await expect(
      transcodeToWav(toneMp3, { ffmpegPath: '/no/such/ffmpeg-binary', ffprobePath: 'ffprobe' }),
    ).rejects.toThrow(TranscodeError);
  });
});
