import { describe, expect, it } from 'vitest';

import { InvalidExportRangeError, toCsv, validateExportRange } from '../src/domain/export.js';

describe('validateExportRange', () => {
  it('accepts a valid range', () => {
    const result = validateExportRange(new Date('2026-01-01'), new Date('2026-01-31'));
    expect(result.fromAt).toEqual(new Date('2026-01-01'));
  });

  it('rejects to <= from', () => {
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
  });

  it('rejects invalid dates', () => {
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
