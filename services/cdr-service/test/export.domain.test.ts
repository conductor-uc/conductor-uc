import { describe, expect, it } from 'vitest';

import {
  InvalidExportRangeError,
  monthWindows,
  toCsv,
  validateExportRange,
} from '../src/domain/export.js';

describe('validateExportRange', () => {
  it('accepts a valid range', () => {
    const result = validateExportRange(new Date('2026-01-01'), new Date('2026-01-31'));
    expect(result.fromAt).toEqual(new Date('2026-01-01'));
  });

  it('rejects to <= from', () => {
    expect(() => validateExportRange(new Date('2026-01-31'), new Date('2026-01-01'))).toThrow(
      expect.objectContaining({ code: 'export_range_reversed' }),
    );
    expect(() => validateExportRange(new Date('2026-01-31'), new Date('2026-01-01'))).toThrow(
      InvalidExportRangeError,
    );
    expect(() => validateExportRange(new Date('2026-01-01'), new Date('2026-01-01'))).toThrow(
      InvalidExportRangeError,
    );
  });

  it('rejects a range spanning more than 366 days', () => {
    expect(() => validateExportRange(new Date('2024-01-01'), new Date('2026-06-01'))).toThrow(
      InvalidExportRangeError,
    );
    expect(() => validateExportRange(new Date('2024-01-01'), new Date('2026-06-01'))).toThrow(
      expect.objectContaining({ code: 'export_range_too_long', params: { maxDays: 366 } }),
    );
  });

  it('S1-16: an unbounded range (the whole history) is not capped', () => {
    expect(() =>
      validateExportRange(new Date(0), new Date('2026-09-28T00:00:00Z'), { unbounded: true }),
    ).not.toThrow();
  });

  it('S1-16: splits a range into calendar months, clipped at both ends', () => {
    expect(
      monthWindows(new Date('2026-01-15T00:00:00Z'), new Date('2026-03-02T00:00:00Z')).map(
        ([a, b]) => [a.toISOString().slice(0, 10), b.toISOString().slice(0, 10)],
      ),
    ).toEqual([
      ['2026-01-15', '2026-02-01'],
      ['2026-02-01', '2026-03-01'],
      ['2026-03-01', '2026-03-02'],
    ]);
  });

  it('rejects invalid dates', () => {
    expect(() => validateExportRange(new Date('not a date'), new Date())).toThrow(
      expect.objectContaining({ code: 'invalid_export_timestamp' }),
    );
    expect(() => validateExportRange(new Date('not a date'), new Date())).toThrow(
      InvalidExportRangeError,
    );
  });
});

describe('toCsv', () => {
  it('writes a header row and one row per CDR', () => {
    const csv = toCsv([
      {
        id: 'cdr-1',
        callUuid: 'call-1',
        direction: 'internal',
        startAt: new Date('2026-01-01T00:00:00.000Z'),
        answerAt: new Date('2026-01-01T00:00:02.000Z'),
        endAt: new Date('2026-01-01T00:00:30.000Z'),
        durationSec: 30,
        billableSec: 28,
        fromNumber: '101',
        fromName: null,
        toNumber: '102',
        dialedNumber: '102',
        did: null,
        trunkId: null,
        disposition: 'answered',
        hangupCause: 'NORMAL_CLEARING',
        hangupBy: 'caller',
      },
    ]);

    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      'id,callUuid,direction,startAt,answerAt,endAt,durationSec,billableSec,fromNumber,fromName,toNumber,dialedNumber,did,trunkId,disposition,hangupCause,hangupBy',
    );
    expect(lines[1]).toContain('cdr-1,call-1,internal');
    expect(lines[1]).toContain('answered,NORMAL_CLEARING,caller');
  });

  it('quotes a field containing a comma', () => {
    const csv = toCsv([
      {
        id: 'cdr-1',
        callUuid: 'call-1',
        direction: 'internal',
        startAt: new Date(),
        answerAt: null,
        endAt: new Date(),
        durationSec: 0,
        billableSec: 0,
        fromNumber: '101',
        fromName: 'Doe, Jane',
        toNumber: '102',
        dialedNumber: '102',
        did: null,
        trunkId: null,
        disposition: 'answered',
        hangupCause: 'NORMAL_CLEARING',
        hangupBy: 'caller',
      },
    ]);
    expect(csv).toContain('"Doe, Jane"');
  });
});
