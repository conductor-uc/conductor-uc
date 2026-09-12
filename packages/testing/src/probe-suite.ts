import { describe, it } from 'vitest';

import {
  assertTenantIsolation,
  type TenantProbeOptions,
  type TenantProbeSubject,
} from './cross-tenant.js';

/**
 * Registers the cross-tenant probe as a Vitest test.
 *
 * Every repository test suite is expected to call this (05 §2.4):
 *
 * ```ts
 * crossTenantProbe({
 *   name: 'extensions',
 *   seed: (tenantId) => repo.create(ctxFor(tenantId), { number: '1001' }),
 *   list: (tenantId) => repo.list(ctxFor(tenantId)),
 *   findById: (tenantId, id) => repo.findById(ctxFor(tenantId), id),
 *   update: (tenantId, id) => repo.rename(ctxFor(tenantId), id, 'probed'),
 *   remove: (tenantId, id) => repo.remove(ctxFor(tenantId), id),
 * });
 * ```
 *
 * `assertTenantIsolation` carries the logic and imports no test framework, so it
 * can be called directly — which is how this package tests the probe itself.
 */
export function crossTenantProbe<Id>(
  subject: TenantProbeSubject<Id>,
  options: TenantProbeOptions = {},
): void {
  describe(`cross-tenant isolation: ${subject.name}`, () => {
    it('does not let one tenant reach another tenant’s rows', async () => {
      await assertTenantIsolation(subject, options);
    });
  });
}
