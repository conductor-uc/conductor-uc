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

/**
 * S5-13: one pause of a recording. `to` is null while it lasts. Paused audio is masked (replaced
 * by silence) in the file, so the file's timeline still matches the call; these say where.
 */
export interface PauseInterval {
  readonly from: Date;
  readonly to: Date | null;
}

/** Reads the stored JSON text; anything unreadable is treated as no pauses. */
export function parsePauseIntervals(text: string | null): PauseInterval[] {
  if (text === null || text === '') return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { from, to } = entry as { from?: unknown; to?: unknown };
      if (typeof from !== 'string') return [];
      return [{ from: new Date(from), to: typeof to === 'string' ? new Date(to) : null }];
    });
  } catch {
    return [];
  }
}

export function serializePauseIntervals(pauses: readonly PauseInterval[]): string | null {
  if (pauses.length === 0) return null;
  return JSON.stringify(
    pauses.map((p) => ({
      from: p.from.toISOString(),
      to: p.to === null ? null : p.to.toISOString(),
    })),
  );
}

export function isPaused(pauses: readonly PauseInterval[]): boolean {
  return pauses.length > 0 && pauses[pauses.length - 1]!.to === null;
}

/** Ends the open pause, if there is one, at `now`. */
export function closeOpenPause(pauses: readonly PauseInterval[], now: Date): PauseInterval[] {
  if (!isPaused(pauses)) return [...pauses];
  return [...pauses.slice(0, -1), { from: pauses[pauses.length - 1]!.from, to: now }];
}

/** Pauses a running recording, or resumes a paused one, at `now`. */
export function togglePauseIntervals(
  pauses: readonly PauseInterval[],
  now: Date,
): { pauses: PauseInterval[]; paused: boolean } {
  if (isPaused(pauses)) return { pauses: closeOpenPause(pauses, now), paused: false };
  return { pauses: [...pauses, { from: now, to: null }], paused: true };
}
