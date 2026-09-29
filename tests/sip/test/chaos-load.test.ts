import { describe, expect, it } from 'vitest';

import { impact, parseStats, type LoadSecond } from '../chaos/load.js';

describe("S4-08 the chaos suite's load statistics", () => {
  it("reads SIPp's per-period statistics", () => {
    const raw = [
      'StartTime;LastResetTime;CurrentTime;ElapsedTime(P);SuccessfulCall(P);SuccessfulCall(C);FailedCall(P);FailedCall(C)',
      '2026-09-29\t00:00:00.000000\t1790000000.000000;2026-09-29\t00:00:00.000000\t1790000000.000000;2026-09-29\t00:00:01.000000\t1790000001.500000;00:00:01;1;1;0;0',
      '2026-09-29\t00:00:00.000000\t1790000000.000000;2026-09-29\t00:00:01.000000\t1790000001.000000;2026-09-29\t00:00:02.000000\t1790000002.500000;00:00:01;0;1;2;2',
      '',
    ].join('\n');
    expect(parseStats(raw)).toEqual([
      { at: 1790000001500, succeeded: 1, failed: 0 },
      { at: 1790000002500, succeeded: 0, failed: 2 },
    ]);
    expect(parseStats('')).toEqual([]);
  });

  it('measures the longest stretch without a successful call across the failure', () => {
    const t0 = 1_790_000_000_000;
    const seconds: LoadSecond[] = Array.from({ length: 30 }, (_, i) => ({
      at: t0 + i * 1000,
      // Calls fail from second 10 to 16, then succeed again.
      succeeded: i >= 10 && i <= 16 ? 0 : 1,
      failed: i >= 12 && i <= 16 ? 1 : 0,
    }));
    const measured = impact(seconds, t0 + 10_000, t0 + 29_000);
    expect(measured.outageSeconds).toBeCloseTo(7, 5);
    expect(measured.failed).toBe(5);
    expect(measured.succeeded).toBe(13);
  });

  it('counts the whole window as an outage when no call succeeds after the failure', () => {
    const t0 = 1_790_000_000_000;
    const seconds: LoadSecond[] = [
      { at: t0, succeeded: 1, failed: 0 },
      { at: t0 + 5_000, succeeded: 0, failed: 3 },
    ];
    expect(impact(seconds, t0 + 1_000, t0 + 40_000).outageSeconds).toBeCloseTo(39, 5);
  });
});
