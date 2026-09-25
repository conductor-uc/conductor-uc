import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import type { ValidPolicy } from '../src/domain/policy.js';
import { PolicyConflictError, PolicyNotFoundError } from '../src/repo/policy.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

const record = (overrides: Partial<ValidPolicy> = {}): ValidPolicy => ({
  scopeType: 'queue',
  scopeId: 'Q1',
  direction: 'any',
  action: 'record',
  announce: false,
  consentAssetId: null,
  ...overrides,
});

describe.skipIf(skipReason !== undefined)('policy repo', () => {
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

  it('creates, lists, updates and deletes a policy', async () => {
    const ctx = { tenantId: crypto.randomUUID() };
    const created = await h.policies.create(ctx, record({ announce: true, consentAssetId: 'A1' }));
    expect(await h.policies.list(ctx)).toEqual([created]);

    const updated = await h.policies.update(
      ctx,
      created.id,
      record({ action: 'no_record', announce: false, consentAssetId: null }),
    );
    expect(updated.action).toBe('no_record');
    expect(await h.policies.findById(ctx, created.id)).toEqual(updated);

    await h.policies.remove(ctx, created.id);
    expect(await h.policies.findById(ctx, created.id)).toBeUndefined();
  });

  it('allows one policy per scope and direction, and a direction-specific one beside it', async () => {
    const ctx = { tenantId: crypto.randomUUID() };
    await h.policies.create(ctx, record());
    await expect(h.policies.create(ctx, record({ action: 'no_record' }))).rejects.toBeInstanceOf(
      PolicyConflictError,
    );
    await expect(h.policies.create(ctx, record({ direction: 'inbound' }))).resolves.toBeDefined();
  });

  it('reports an unknown policy on update and delete', async () => {
    const ctx = { tenantId: crypto.randomUUID() };
    await expect(h.policies.update(ctx, 'nope', record())).rejects.toBeInstanceOf(
      PolicyNotFoundError,
    );
    await expect(h.policies.remove(ctx, 'nope')).rejects.toBeInstanceOf(PolicyNotFoundError);
  });

  it('a no-op update of an existing policy is not "not found"', async () => {
    const ctx = { tenantId: crypto.randomUUID() };
    const created = await h.policies.create(ctx, record());
    await expect(h.policies.update(ctx, created.id, record())).resolves.toMatchObject({
      id: created.id,
    });
  });

  it('enqueues an event and an audit record in the same transaction as each write', async () => {
    const tenantId = crypto.randomUUID();
    const audit = {
      actorType: 'user' as const,
      actorId: 'u1',
      actorOrgId: tenantId,
      targetOrgId: tenantId,
      action: 'recording.policy.created',
      resource: 'recording-policy',
      dataClass: 'config' as const,
    };
    const created = await h.policies.create({ tenantId }, record(), audit);
    await h.policies.remove({ tenantId }, created.id, {
      ...audit,
      action: 'recording.policy.deleted',
    });

    const rows = await h.db.kysely
      .selectFrom('outbox')
      .select(['type', 'tenant_id as tenantId', 'payload'])
      .execute();
    expect(rows.map((r) => r.type)).toEqual(
      expect.arrayContaining([
        'recording.policy.created',
        'recording.policy.deleted',
        'audit.event.recorded',
      ]),
    );
    const policyEvent = rows.find((r) => r.type === 'recording.policy.created');
    expect(policyEvent).toMatchObject({ tenantId, payload: { policyId: created.id } });
  });

  it('writes nothing when the write fails', async () => {
    const ctx = { tenantId: crypto.randomUUID() };
    await h.policies.create(ctx, record());
    await h.db.kysely.deleteFrom('outbox').execute();
    await expect(h.policies.create(ctx, record())).rejects.toBeInstanceOf(PolicyConflictError);
    expect(await h.db.kysely.selectFrom('outbox').selectAll().execute()).toEqual([]);
  });

  // 05 §2.4: every repository test suite includes a cross-tenant probe.
  crossTenantProbe({
    name: 'recording_policies',
    seed: (tenantId) => h.policies.create({ tenantId }, record()).then((row) => row.id),
    list: (tenantId) => h.policies.list({ tenantId }),
    findById: (tenantId, id) => h.policies.findById({ tenantId }, id),
    update: (tenantId, id) =>
      h.policies
        .update({ tenantId }, id, record({ action: 'no_record' }))
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof PolicyNotFoundError) return 0;
          throw error;
        }),
    remove: (tenantId, id) =>
      h.policies
        .remove({ tenantId }, id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof PolicyNotFoundError) return 0;
          throw error;
        }),
  });
});
