import type { Transaction } from '@cuc/db';

import type { Projection } from './projection.js';
import type { ReadModelRepo } from './repo/read-model.repo.js';
import type { TelephonyConfigDb } from './schema.js';

/**
 * S1-16 (G-11 (3)): a deleted tenant leaves the SIP edge and the media nodes.
 * Everything it projected into OpenSIPs goes through the same removals a
 * single deletion uses (subscribers, trunks' registrants, addresses and
 * gateways, routing rules, the domain), then its read-model rows go, so
 * FreeSWITCH (which reads its configuration from them) no longer knows it.
 *
 * The read model is not `scoped(ctx)`, as `read-model.repo.ts` explains, so
 * every query here names the tenant. Safe to repeat: a second run finds
 * nothing left.
 */
export async function purgeTenant(
  trx: Transaction<TelephonyConfigDb>,
  tenantId: string,
  projection: Projection,
  readModel: ReadModelRepo,
): Promise<void> {
  const ids = async (
    table: 'extensions' | 'trunks' | 'outbound_routes' | 'emergency_routes',
  ): Promise<string[]> =>
    (await trx.selectFrom(table).select('id').where('tenant_id', '=', tenantId).execute()).map(
      (row) => row.id,
    );

  for (const id of await ids('extensions')) await projection.removeExtension(trx, id);
  for (const id of await ids('outbound_routes')) await projection.removeOutboundRoute(trx, id);
  for (const id of await ids('emergency_routes')) await projection.removeEmergencyRoute(trx, id);
  for (const id of await ids('trunks')) await projection.removeTrunk(trx, id);

  const domain = await readModel.findDomain(trx, tenantId);
  if (domain !== undefined) await projection.deactivateDomain(domain.fqdn);

  for (const table of [
    'extension_presence',
    'extension_call_handling',
    'recording_settings',
    'queue_tiers',
    'agents',
    'queues',
    'ring_groups',
    'parking_lots',
    'conference_rooms',
    'dids',
    'domains',
    'tenant_dr_groups',
  ] as const) {
    await trx.deleteFrom(table).where('tenant_id', '=', tenantId).execute();
  }
  await trx.deleteFrom('tenants').where('id', '=', tenantId).execute();
}
