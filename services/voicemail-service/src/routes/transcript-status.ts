import type { TranscriptStatus } from '../repo/message.repo.js';

/** S5-06: a message's transcript status as the API shows it; a transcription under way is still pending. */
export function publicTranscriptStatus(
  status: TranscriptStatus,
): 'none' | 'pending' | 'done' | 'failed' {
  return status === 'working' ? 'pending' : status;
}
