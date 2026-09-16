import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Whether `ffmpeg`/`ffprobe` are on `$PATH` here, with a reason when they are
 * not — the same "skip with something a reader can act on" shape
 * `@cuc/testing`'s `databaseOrSkipReason`/`s3OrSkipReason` already establish
 * for the infra dependencies those helpers cover. Kept local to this
 * service rather than added to `@cuc/testing`: no other service's test
 * suite needs it, and `@cuc/testing` is for genuinely shared infra, not a
 * one-consumer external-tool check.
 */
export async function ffmpegOrSkipReason(): Promise<string | undefined> {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    await execFileAsync('ffprobe', ['-version']);
    return undefined;
  } catch {
    return 'ffmpeg/ffprobe are not on $PATH — install the ffmpeg package to run this suite';
  }
}
