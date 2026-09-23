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
}

export function validateExportRange(fromAt: Date, toAt: Date): { fromAt: Date; toAt: Date } {
  if (Number.isNaN(fromAt.getTime()) || Number.isNaN(toAt.getTime())) {
    throw new InvalidExportRangeError('from and to must be valid RFC 3339 timestamps.');
  }
  if (toAt <= fromAt) {
    throw new InvalidExportRangeError('to must be after from.');
  }
  const spanDays = (toAt.getTime() - fromAt.getTime()) / (24 * 60 * 60 * 1000);
  if (spanDays > MAX_RANGE_DAYS) {
    throw new InvalidExportRangeError(
      `from/to cannot span more than ${String(MAX_RANGE_DAYS)} days.`,
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
  const lines = [CSV_COLUMNS.join(',')];
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
  return lines.join('\r\n') + '\r\n';
}
