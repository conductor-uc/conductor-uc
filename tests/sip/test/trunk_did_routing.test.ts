import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  tenantAdminCurlJson,
  runForeground,
  seedFixtures,
  sipInfraOrSkipReason,
  startDelayedCaller,
  startUas,
  stopContainer,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
/** OpenSIPs' own SIP identity — a carrier addresses its trunk termination point, never a tenant's own domain. */
const CARRIER_TARGET_DOMAIN = 'opensips';

interface CreatedTrunk {
  readonly id: string;
}
interface ExtensionRow {
  readonly id: string;
  readonly number: string;
}

/**
 * S2-03's own acceptance test: DID CRUD + inbound routing, verified against
 * a real compose stack — the same "run the literal SIPp scenario the plan's
 * own 'Done when' describes" discipline S2-01/S2-02 established.
 *
 * All three "Done when" clauses get their own case: a carrier INVITE to a
 * DID rings the right extension, an INVITE from an unknown IP is rejected,
 * and a DID owned by tenant B arriving on tenant A's trunk is rejected.
 *
 * Every trunk/DID this file creates is deleted in its own test's `finally`,
 * not batched into one `afterAll` — this compose network's small subnet
 * reuses a stopped container's IP for the very next `docker run` almost
 * immediately (confirmed live: an earlier version of this suite that
 * deferred cleanup to `afterAll` saw its own "unrecognized source IP" case
 * spuriously match a *prior* test's still-projected trunk, because the new
 * caller container happened to recycle that trunk's own whitelisted IP).
 * Deleting a trunk's `address` projection the moment its test is done
 * removes that risk entirely, regardless of what IP Docker hands out next.
 */
describe.skipIf(skipReason !== undefined)('S2-03 DID inbound routing', () => {
  let seed: SeedResult;
  const activeContainers = new Set<string>();

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterAll(async () => {
    await Promise.all([...activeContainers].map((name) => stopContainer(name)));
    activeContainers.clear();
  });

  async function createIpTrunk(tenantId: string, ip: string, name: string): Promise<CreatedTrunk> {
    const created = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
      {
        name,
        authMode: 'ip',
        host: ip,
        port: 5060,
        transport: 'udp',
        codecs: ['PCMU'],
      },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const trunk = created.json as CreatedTrunk;

    // `ips` is not part of the create body (trunk-service's own dedicated
    // sub-resource, S2-01) — the address-table whitelist a trunk's inbound
    // identification actually depends on is added here, separately.
    const ipAdded = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunk.id}/ips`,
      { cidr: `${ip}/32` },
    );
    expect(ipAdded.status, JSON.stringify(ipAdded.json)).toBe(201);

    return trunk;
  }

  async function deleteTrunk(tenantId: string, trunkId: string): Promise<void> {
    await tenantAdminCurlJson(
      seed.resellerId,
      'DELETE',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}`,
    );
    // `trunk.trunk.deleted` removes the `address` projection asynchronously
    // (event-driven, S2-02) — this gives that a real window to land before
    // the next test's own caller container might recycle this exact IP
    // (this file's own top comment on why deletion is per-test, not
    // deferred). Typically sub-second in practice; generous on purpose.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  async function deleteDid(tenantId: string, didId: string): Promise<void> {
    await tenantAdminCurlJson(
      seed.resellerId,
      'DELETE',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids/${didId}`,
    );
  }

  async function findExtensionId(tenantId: string, number: string): Promise<string> {
    const response = await tenantAdminCurlJson(
      seed.resellerId,
      'GET',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions`,
    );
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    const { rows } = response.json as { rows: ExtensionRow[] };
    const extension = rows.find((row) => row.number === number);
    if (extension === undefined) throw new Error(`no seeded extension '${number}' for ${tenantId}`);
    return extension.id;
  }

  async function createDid(
    tenantId: string,
    e164: string,
    trunkId: string,
    destinationId: string,
  ): Promise<string> {
    const created = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids`,
      {
        e164,
        trunkId,
        destinationType: 'extension',
        destinationId,
      },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return (created.json as { id: string }).id;
  }

  it('a carrier INVITE to a DID rings the bound extension, answered, hung up', async () => {
    await clearRegistration(`101@${seed.tenantA.fqdn}`);
    const a101 = seed.extensions[`${seed.tenantA.fqdn}/101`];
    if (a101 === undefined) throw new Error('tenantA/101 was not seeded');

    const uas = startUas({
      au: '101',
      ap: a101.password,
      authUri: seed.tenantA.fqdn,
      csvLine: `101;${seed.tenantA.fqdn}`,
      containerName: 'sip-test-did-uas',
    });
    activeContainers.add(uas.containerName);
    await uas.ready();

    const caller = await startDelayedCaller({
      scenario: 'trunk_invite.xml',
      csvLine: `carrier;${CARRIER_TARGET_DOMAIN};+15559990001`,
      containerName: 'sip-test-did-caller',
    });
    activeContainers.add(caller.containerName);

    const trunk = await createIpTrunk(seed.tenantA.id, caller.ip, 'S2-03 rings-extension trunk');
    let didId: string | undefined;
    try {
      const extensionId = await findExtensionId(seed.tenantA.id, '101');
      didId = await createDid(seed.tenantA.id, '+15559990001', trunk.id, extensionId);

      const result = await caller.result();
      expect(result.successfulCalls, result.stdout).toBe(1);
      expect(result.failedCalls, result.stdout).toBe(0);

      const uasResult = await uas.result();
      expect(uasResult.successfulCalls, uasResult.stdout).toBe(1);
    } finally {
      if (didId !== undefined) await deleteDid(seed.tenantA.id, didId);
      await deleteTrunk(seed.tenantA.id, trunk.id);
    }
  }, 30_000);

  it('an INVITE from an unrecognized source IP is rejected (403)', async () => {
    const result = await runForeground({
      scenario: 'trunk_invite_expect_403.xml',
      csvLine: `carrier;${CARRIER_TARGET_DOMAIN};+15559990002`,
      containerName: 'sip-test-did-unknown-ip',
    });
    expect(result.successfulCalls, result.stdout).toBe(1);
    expect(result.failedCalls, result.stdout).toBe(0);
  });

  it("a DID owned by tenant B arriving on tenant A's trunk is rejected (404)", async () => {
    const b102Id = await findExtensionId(seed.tenantB.id, '102');

    const caller = await startDelayedCaller({
      scenario: 'trunk_invite_expect_404.xml',
      csvLine: `carrier;${CARRIER_TARGET_DOMAIN};+15559990003`,
      containerName: 'sip-test-did-cross-tenant',
    });
    activeContainers.add(caller.containerName);

    // The DID exists, and resolves to a real extension — but is owned by
    // tenant B, while the call below arrives on a trunk provisioned for
    // tenant A. `findDidByE164` scopes to the *trunk's* tenant, so this DID
    // is invisible there — the whole point of this test.
    const trunkB = await createIpTrunk(
      seed.tenantB.id,
      '203.0.113.1',
      'S2-03 cross-tenant trunk B',
    );
    let didId: string | undefined;
    let trunkA: CreatedTrunk | undefined;
    try {
      didId = await createDid(seed.tenantB.id, '+15559990003', trunkB.id, b102Id);
      trunkA = await createIpTrunk(seed.tenantA.id, caller.ip, 'S2-03 cross-tenant trunk A');

      const result = await caller.result();
      expect(result.successfulCalls, result.stdout).toBe(1);
      expect(result.failedCalls, result.stdout).toBe(0);
    } finally {
      if (didId !== undefined) await deleteDid(seed.tenantB.id, didId);
      if (trunkA !== undefined) await deleteTrunk(seed.tenantA.id, trunkA.id);
      await deleteTrunk(seed.tenantB.id, trunkB.id);
    }
  }, 30_000);
});
