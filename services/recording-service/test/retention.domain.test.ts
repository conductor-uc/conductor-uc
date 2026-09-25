import { describe, expect, it } from 'vitest';

import {
  InvalidRetentionError,
  lifecycleExpirationDays,
  retentionDateFor,
  validateRetentionDays,
} from '../src/domain/retention.js';
import { recordingObjectKey, spoolFileName } from '../src/domain/recording.js';

describe('retention', () => {
  it('adds whole days to the start time, and none when retention is off', () => {
    const started = new Date('2026-03-01T10:00:00.000Z');
    expect(retentionDateFor(started, 30)?.toISOString()).toBe('2026-03-31T10:00:00.000Z');
    expect(retentionDateFor(started, 0)).toBeNull();
  });

  it('accepts 0 to ten years and rejects anything else', () => {
    expect(validateRetentionDays(0)).toBe(0);
    expect(validateRetentionDays(3650)).toBe(3650);
    for (const bad of [-1, 3651, 1.5, Number.NaN]) {
      expect(() => validateRetentionDays(bad)).toThrow(InvalidRetentionError);
    }
  });

  it('sets the bucket rule a day after the database retention, and none when off', () => {
    expect(lifecycleExpirationDays(30)).toBe(31);
    expect(lifecycleExpirationDays(0)).toBeNull();
  });
});

describe('recording names', () => {
  it('lays keys out by date and names the file by the opaque id only', () => {
    const id = '5f1c2b7e-0a3d-4c1e-9d2a-7b8e4f6a1c3d';
    expect(recordingObjectKey(id, new Date('2026-03-05T23:59:00.000Z'))).toBe(
      `recordings/2026/03/05/${id}.wav`,
    );
    expect(spoolFileName(id)).toBe(`${id}.wav`);
  });
});
