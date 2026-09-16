import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The one thing this whole service exists to isolate (S2-07): running
 * `ffmpeg`/`ffprobe` against a tenant's raw, untrusted upload. Every input
 * is a real temp file, not a pipe — `ffprobe`'s own duration read needs a
 * seekable input for some containers (confirmed against real MP3s: a piped
 * stdin duration probe is unreliable, a file path is not), and running two
 * separate `ffmpeg` invocations (one per sample rate) against the same file
 * is simpler and more obviously correct than trying to fan one process's
 * output into two.
 */

export interface TranscodePaths {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
}

export interface TranscodeOutput {
  readonly durationMs: number;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly wav8k: Buffer;
  readonly wav16k: Buffer;
}

/** Covers both a corrupt/non-audio upload (`ffmpeg`/`ffprobe` rejecting it) and this host's own tooling being missing/broken. */
export class TranscodeError extends Error {
  override readonly name = 'TranscodeError';
}

const SAMPLE_RATES = { wav8k: 8000, wav16k: 16000 } as const;

export async function transcodeToWav(
  input: Buffer,
  paths: TranscodePaths,
): Promise<TranscodeOutput> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'media-worker-'));
  try {
    const inputPath = path.join(workDir, 'input');
    await writeFile(inputPath, input);

    const durationMs = await probeDurationMs(inputPath, paths.ffprobePath);

    const wav8kPath = path.join(workDir, 'output-8k.wav');
    const wav16kPath = path.join(workDir, 'output-16k.wav');
    await runFfmpeg(paths.ffmpegPath, inputPath, wav8kPath, SAMPLE_RATES.wav8k);
    await runFfmpeg(paths.ffmpegPath, inputPath, wav16kPath, SAMPLE_RATES.wav16k);

    const [wav8k, wav16k] = await Promise.all([readFile(wav8kPath), readFile(wav16kPath)]);

    return {
      durationMs,
      sha256: createHash('sha256').update(input).digest('hex'),
      sizeBytes: input.length,
      wav8k,
      wav16k,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function runFfmpeg(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  sampleRateHz: number,
): Promise<void> {
  try {
    // `-ac 1`: mono (issue #31's own "8 kHz and 16 kHz mono WAV"). `-y`:
    // overwrite — the temp dir is fresh per job, but a stale leftover from a
    // process that got SIGKILLed mid-job should never turn into an
    // "output already exists" failure on the next attempt.
    await execFileAsync(ffmpegPath, [
      '-y',
      '-i',
      inputPath,
      '-ar',
      String(sampleRateHz),
      '-ac',
      '1',
      '-f',
      'wav',
      outputPath,
    ]);
  } catch (error) {
    throw new TranscodeError(`ffmpeg failed at ${String(sampleRateHz)}Hz: ${describe(error)}`);
  }
}

async function probeDurationMs(inputPath: string, ffprobePath: string): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ffprobePath, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      inputPath,
    ]));
  } catch (error) {
    throw new TranscodeError(`ffprobe failed: ${describe(error)}`);
  }

  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds)) {
    throw new TranscodeError(`ffprobe returned a non-numeric duration: '${stdout.trim()}'`);
  }
  return Math.round(seconds * 1000);
}

/** `ffmpeg`/`ffprobe`'s own stderr is verbose (codec probing, build info); the actual failure reason is reliably in the last few lines. */
function describe(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'stderr' in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim() !== '') {
      return stderr.trim().split('\n').slice(-3).join(' ');
    }
  }
  return error instanceof Error ? error.message : String(error);
}
