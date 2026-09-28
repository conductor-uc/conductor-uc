/**
 * Pure business logic for async CDR CSV exports (S2-18; 06's cdr-service
 * section: "`POST /v1/tenants/{t}/cdr-exports` (async CSV to S3)"). No DB
 * here — `repo/export.repo.ts` is where this meets actual rows.
 */

export const EXPORT_STATUSES = ['pending', 'processing', 'ready', 'failed'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

// A year is generous for a billing export and cheap to bound: without a
// cap, a client could request `from=1970-01-01` against a partitioned,
// potentially-years-deep table and force a full-table scan.
const MAX_RANGE_DAYS = 366;

export class InvalidExportRangeError extends Error {
  override readonly name = 'InvalidExportRangeError';

  constructor(
    message: string,
    /** Stable problem code for the route to return (S9-02). */
    readonly code: string,
    readonly params?: Readonly<Record<string, number>>,
  ) {
    super(message);
  }
}

/**
 * `unbounded` (S1-16): the whole history a tenant still has, for the export
 * offered before an org is deleted. The worker reads it a month at a time
 * (partition by partition), so the cap that protects a live query is not
 * needed there.
 */
export function validateExportRange(
  fromAt: Date,
  toAt: Date,
  options: { readonly unbounded?: boolean } = {},
): { fromAt: Date; toAt: Date } {
  if (Number.isNaN(fromAt.getTime()) || Number.isNaN(toAt.getTime())) {
    throw new InvalidExportRangeError(
      'from and to must be valid RFC 3339 timestamps.',
      'invalid_export_timestamp',
    );
  }
  if (toAt <= fromAt) {
    throw new InvalidExportRangeError('to must be after from.', 'export_range_reversed');
  }
  const spanDays = (toAt.getTime() - fromAt.getTime()) / (24 * 60 * 60 * 1000);
  if (options.unbounded !== true && spanDays > MAX_RANGE_DAYS) {
    throw new InvalidExportRangeError(
      `from/to cannot span more than ${String(MAX_RANGE_DAYS)} days.`,
      'export_range_too_long',
      { maxDays: MAX_RANGE_DAYS },
    );
  }
  return { fromAt, toAt };
}

const CSV_COLUMNS = [
  'id',
  'callUuid',
  'direction',
  'startAt',
  'answerAt',
  'endAt',
  'durationSec',
  'billableSec',
  'fromNumber',
  'fromName',
  'toNumber',
  'dialedNumber',
  'did',
  'trunkId',
  'disposition',
  'hangupCause',
  'hangupBy',
] as const;

/** One CDR, shaped for a CSV row — deliberately the `private`-class fields only (no `legs`/`sip`, which stay JSON-only, never spreadsheet-exported). */
export interface CsvCdrRow {
  readonly id: string;
  readonly callUuid: string;
  readonly direction: string;
  readonly startAt: Date;
  readonly answerAt: Date | null;
  readonly endAt: Date;
  readonly durationSec: number;
  readonly billableSec: number;
  readonly fromNumber: string;
  readonly fromName: string | null;
  readonly toNumber: string;
  readonly dialedNumber: string;
  readonly did: string | null;
  readonly trunkId: string | null;
  readonly disposition: string;
  readonly hangupCause: string;
  readonly hangupBy: string;
}

function csvField(value: string): string {
  if (!/[",\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** RFC 4180 CSV, header first. Small/simple enough (no embedded objects) that a dependency would be overkill. */
export function toCsv(rows: readonly CsvCdrRow[]): string {
  return csvHeader() + csvLines(rows);
}

/** The CSV's header line (S1-16: written once, before the rows arrive a month at a time). */
export function csvHeader(): string {
  return CSV_COLUMNS.join(',') + '\r\n';
}

/** The CSV lines for [rows], without the header; empty for none. */
export function csvLines(rows: readonly CsvCdrRow[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.callUuid,
        row.direction,
        row.startAt.toISOString(),
        row.answerAt?.toISOString() ?? '',
        row.endAt.toISOString(),
        String(row.durationSec),
        String(row.billableSec),
        row.fromNumber,
        row.fromName ?? '',
        row.toNumber,
        row.dialedNumber,
        row.did ?? '',
        row.trunkId ?? '',
        row.disposition,
        row.hangupCause,
        row.hangupBy,
      ]
        .map(csvField)
        .join(','),
    );
  }
  return lines.length === 0 ? '' : lines.join('\r\n') + '\r\n';
}

/** Calendar months (UTC) covering [from, to), each clipped to the range: the cdrs partitions. */
export function monthWindows(from: Date, to: Date): [Date, Date][] {
  const windows: [Date, Date][] = [];
  let start = from;
  while (start < to) {
    const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const end = next < to ? next : to;
    windows.push([start, end]);
    start = end;
  }
  return windows;
}
