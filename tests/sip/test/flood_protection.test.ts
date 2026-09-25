import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  opensipsMi,
  seedFixtures,
  sipInfraOrSkipReason,
  startDelayedCaller,
  stopContainer,
  tenantAdminCurlJson,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const CARRIER_CONTAINER = 'sip-test-flood-carrier';
const STRANGER_CONTAINER = 'sip-test-flood-stranger';

/**
 * G-117: OpenSIPs' flood protection (`pike`, more than 30 requests in 2 s from
 * one source blocks it) exempts the peers the proxy already trusts. An address
 * listed on a trunk can send a burst of 80 OPTIONS and have every one answered;
 * an unknown address sending the same burst is still blocked. (FreeSWITCH nodes
 * are exempt by the same rule, through the dispatcher list every call in this
 * suite already relies on.)
 */
describe.skipIf(skipReason !== undefined)('SIP flood protection (live SIPp)', () => {
  let seed: SeedResult;
  let trunkId: string | undefined;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await stopContainer(CARRIER_CONTAINER);
    await stopContainer(STRANGER_CONTAINER);
    if (trunkId !== undefined) {
      await tenantAdminCurlJson(
        seed.resellerId,
        'DELETE',
        `${TRUNK_SERVICE_URL}/v1/tenants/${seed.tenantA.id}/trunks/${trunkId}`,
      );
      trunkId = undefined;
    }
  });

  it('answers every request in a burst from an address listed on a trunk', async () => {
    const tenantId = seed.tenantA.id;
    const carrier = await startDelayedCaller({
      scenario: 'options_burst.xml',
      csvLine: 'carrier;opensips',
      containerName: CARRIER_CONTAINER,
    });

    const trunk = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
      {
        name: 'flood protection trunk',
        authMode: 'ip',
        host: carrier.ip,
        port: 5060,
        transport: 'udp',
        codecs: ['PCMU'],
      },
    );
    expect(trunk.status, JSON.stringify(trunk.json)).toBe(201);
    trunkId = (trunk.json as { id: string }).id;
    const ip = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}/ips`,
      { cidr: `${carrier.ip}/32` },
    );
    expect(ip.status, JSON.stringify(ip.json)).toBe(201);

    const result = await carrier.result();
    expect(result.successfulCalls, result.stdout).toBe(1);
  }, 120_000);

  it('still blocks the same burst from an unknown address', async () => {
    const stranger = await startDelayedCaller({
      scenario: 'options_burst.xml',
      csvLine: 'stranger;opensips',
      containerName: STRANGER_CONTAINER,
    });
    try {
      const result = await stranger.result();
      expect(result.successfulCalls, result.stdout).toBe(0);
    } finally {
      // The block lasts 120 s; lift it so a later test container that is given
      // the same address is not caught by it.
      await opensipsMi('pike_rm', stranger.ip).catch(() => undefined);
    }
  }, 120_000);
});
