import { describe, expect, it } from 'vitest';

import { newEventId } from '../src/outbox.js';

describe('newEventId', () => {
  it('is a UUIDv7 carrying the time it was made', () => {
    const before = Date.now();
    const id = newEventId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const ms = Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(Date.now() + 1);
  });

  it('sorts in the order the ids were made, many to a millisecond', () => {
    const ids = Array.from({ length: 10_000 }, () => newEventId());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
