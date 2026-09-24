import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import type { NormalizedCdr } from '../src/domain/cdr.js';
import { CdrAlreadyIngestedError } from '../src/repo/cdr.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

function sample(overrides: Partial<NormalizedCdr> = {}): NormalizedCdr {
  return {
    tenantId: 'tenant-a',
    callUuid: crypto.randomUUID(),
    nodeId: 'fs-1',
    direction: 'internal',
    startAt: new Date('2026-01-15T10:00:00.000Z'),
    answerAt: new Date('2026-01-15T10:00:02.000Z'),
    endAt: new Date('2026-01-15T10:00:30.000Z'),
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
    legs: null,
    sip: {},
    ...overrides,
  };
}

describe.skipIf(skipReason !== undefined)('cdr repo', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  it('ingests a normalized CDR and enqueues cdr.record.created', async () => {
    const created = await h.cdrs.ingest(sample(), 'reseller-a');

    expect(created).toMatchObject({
      tenantId: 'tenant-a',
      resellerId: 'reseller-a',
      disposition: 'answered',
      billableSec: 28,
    });

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'cdr.record.created')).toBe(true);
  });

  it('rejects a second ingest for the same (call_uuid, node_id) as already ingested', async () => {
    const callUuid = crypto.randomUUID();
    await h.cdrs.ingest(sample({ callUuid, nodeId: 'fs-1' }), null);

    await expect(h.cdrs.ingest(sample({ callUuid, nodeId: 'fs-1' }), null)).rejects.toThrow(
      CdrAlreadyIngestedError,
    );
  });

  it('allows the same call_uuid on a different node (a distinct dedupe key)', async () => {
    const callUuid = crypto.randomUUID();
    await h.cdrs.ingest(sample({ callUuid, nodeId: 'fs-1' }), null);
    const second = await h.cdrs.ingest(sample({ callUuid, nodeId: 'fs-2' }), null);
    expect(second.nodeId).toBe('fs-2');
  });

  it('finds a CDR by id, scoped to its tenant', async () => {
    const created = await h.cdrs.ingest(sample({ tenantId: 'tenant-b' }), null);

    expect(await h.cdrs.findById({ tenantId: 'tenant-b' }, created.id)).toMatchObject({
      id: created.id,
    });
    expect(await h.cdrs.findById({ tenantId: 'tenant-a' }, created.id)).toBeUndefined();
  });

  it('lists CDRs for a tenant, most recent first', async () => {
    const tenantId = 'tenant-list';
    await h.cdrs.ingest(sample({ tenantId, startAt: new Date('2026-01-01T00:00:00.000Z') }), null);
    await h.cdrs.ingest(sample({ tenantId, startAt: new Date('2026-01-02T00:00:00.000Z') }), null);

    const page = await h.cdrs.list({ tenantId });
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]?.startAt.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(page.rows[1]?.startAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(page.nextCursor).toBeNull();
  });

  it('filters by from/to/direction/did', async () => {
    const tenantId = 'tenant-filter';
    await h.cdrs.ingest(
      sample({
        tenantId,
        direction: 'inbound',
        did: '+15551234567',
        startAt: new Date('2026-01-05T00:00:00.000Z'),
      }),
      null,
    );
    await h.cdrs.ingest(
      sample({ tenantId, direction: 'internal', startAt: new Date('2026-01-10T00:00:00.000Z') }),
      null,
    );

    const byDirection = await h.cdrs.list({ tenantId }, { direction: 'inbound' });
    expect(byDirection.rows).toHaveLength(1);
    expect(byDirection.rows[0]?.did).toBe('+15551234567');

    const byDid = await h.cdrs.list({ tenantId }, { did: '+15551234567' });
    expect(byDid.rows).toHaveLength(1);

    const byRange = await h.cdrs.list(
      { tenantId },
      { from: new Date('2026-01-08T00:00:00.000Z'), to: new Date('2026-01-12T00:00:00.000Z') },
    );
    expect(byRange.rows).toHaveLength(1);
    expect(byRange.rows[0]?.direction).toBe('internal');
  });

  it('filters by a number that is the caller, the callee or the dialed number', async () => {
    const tenantId = 'tenant-number';
    await h.cdrs.ingest(
      sample({ tenantId, fromNumber: '101', toNumber: '102', dialedNumber: '102' }),
      null,
    );
    await h.cdrs.ingest(
      sample({ tenantId, fromNumber: '103', toNumber: '101', dialedNumber: '101' }),
      null,
    );
    await h.cdrs.ingest(
      sample({ tenantId, fromNumber: '+15550001', toNumber: '104', dialedNumber: '+15550100' }),
      null,
    );

    const ext101 = await h.cdrs.list({ tenantId }, { number: '101' });
    expect(ext101.rows).toHaveLength(2);
    const dialed = await h.cdrs.list({ tenantId }, { number: '+15550100' });
    expect(dialed.rows).toHaveLength(1);
    expect(dialed.rows[0]?.toNumber).toBe('104');
    expect((await h.cdrs.list({ tenantId }, { number: '999' })).rows).toHaveLength(0);
    // Never another tenant's calls.
    expect((await h.cdrs.list({ tenantId: 'someone-else' }, { number: '101' })).rows).toHaveLength(
      0,
    );
  });

  it('paginates with a cursor, one row at a time', async () => {
    const tenantId = 'tenant-page';
    for (let day = 1; day <= 3; day++) {
      await h.cdrs.ingest(
        sample({ tenantId, startAt: new Date(`2026-02-0${String(day)}T00:00:00.000Z`) }),
        null,
      );
    }

    const first = await h.cdrs.list({ tenantId }, { limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.startAt.toISOString()).toBe('2026-02-03T00:00:00.000Z');
    expect(first.nextCursor).not.toBeNull();

    const second = await h.cdrs.list({ tenantId }, { limit: 1, cursor: first.nextCursor! });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.startAt.toISOString()).toBe('2026-02-02T00:00:00.000Z');

    expect(second.nextCursor).not.toBeNull();
    const third = await h.cdrs.list({ tenantId }, { limit: 1, cursor: second.nextCursor! });
    expect(third.rows).toHaveLength(1);
    expect(third.rows[0]?.startAt.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(third.nextCursor).toBeNull();
  });

  it('does not leak a CDR across tenants', async () => {
    await h.cdrs.ingest(sample({ tenantId: 'tenant-x' }), null);
    const page = await h.cdrs.list({ tenantId: 'tenant-y' });
    expect(page.rows).toHaveLength(0);
  });

  it('listAllInRange walks every page', async () => {
    const tenantId = 'tenant-walk';
    for (let day = 1; day <= 3; day++) {
      await h.cdrs.ingest(
        sample({ tenantId, startAt: new Date(`2026-03-0${String(day)}T00:00:00.000Z`) }),
        null,
      );
    }

    const all = await h.cdrs.listAllInRange(
      tenantId,
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-31T00:00:00.000Z'),
    );
    expect(all).toHaveLength(3);
  });
});
