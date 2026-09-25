/** Recording metadata rules (S5-03, S5-04). Pure. */

export const RECORDING_STATUSES = ['pending', 'ready', 'failed', 'expired'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export const RECORDING_CONTENT_TYPE = 'audio/wav';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isRecordingId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Where a recording lives in its tenant's bucket (05 §4). The layout follows
 * `recordings/{yyyy}/{mm}/{dd}/...` but names the file by the opaque recording id rather
 * than the call uuid, so nothing in a key or a spool file name ties it to a call.
 */
export function recordingObjectKey(id: string, startedAt: Date): string {
  const y = String(startedAt.getUTCFullYear());
  const m = String(startedAt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(startedAt.getUTCDate()).padStart(2, '0');
  return `recordings/${y}/${m}/${d}/${id}.wav`;
}

/** The file name FreeSWITCH writes in the node's spool directory. */
export function spoolFileName(id: string): string {
  return `${id}.wav`;
}

/** The name a browser saves a downloaded recording under: opaque, no tenant or party in it. */
export function downloadFileName(id: string): string {
  return `recording-${id}.wav`;
}
