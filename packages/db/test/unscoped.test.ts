import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import {
  loggingUnscopedSink,
  MissingUnscopedReasonError,
  unscopedFor,
  type UnscopedAccess,
} from '../src/unscoped.js';
import { captureLogger } from './helpers.js';

const db = {} as Kysely<unknown>;
const ctx = {
  tenantId: 'tenant-a',
  orgId: 'org-1',
  orgType: 'master' as const,
  actorId: 'user-1',
  requestId: 'r-1',
};

describe('unscoped', () => {
  it('returns the unscoped instance when given a reason', () => {
    expect(unscopedFor(db, ctx, 'master dashboard: tenants by status', vi.fn())).toBe(db);
  });

  it('refuses an empty reason', () => {
    expect(() => unscopedFor(db, ctx, '', vi.fn())).toThrow(MissingUnscopedReasonError);
    expect(() => unscopedFor(db, ctx, '   ', vi.fn())).toThrow(MissingUnscopedReasonError);
  });

  it('reports the access to the sink with the actor and the reason', () => {
    const sink = vi.fn<(access: UnscopedAccess) => void>();

    unscopedFor(db, ctx, 'nightly usage rollup', sink);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).toMatchObject({
      reason: 'nightly usage rollup',
      actorId: 'user-1',
      orgId: 'org-1',
      orgType: 'master',
      requestId: 'r-1',
    });
  });

  it('omits context fields that are not known', () => {
    const sink = vi.fn<(access: UnscopedAccess) => void>();

    unscopedFor(db, { orgType: 'master' }, 'relay worker', sink);

    const access = sink.mock.calls[0]![0];
    expect(access).not.toHaveProperty('actorId');
    expect(access).not.toHaveProperty('tenantId');
  });

  it('makes a cross-tenant query visible in a log search by default', () => {
    const { lines, logger } = captureLogger();

    unscopedFor(db, ctx, 'reseller tenant summary', loggingUnscopedSink(logger));

    const line = lines.find((entry) => entry['msg'] === 'cross-tenant query');
    expect(line).toBeDefined();
    expect(line!['level']).toBe('warn');
    expect(JSON.stringify(line)).toContain('reseller tenant summary');
  });
});
