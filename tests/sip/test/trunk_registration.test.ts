import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  dockerCurlJson,
  seedFixtures,
  sipInfraOrSkipReason,
  startBackgroundUas,
  stopContainer,
  type SeedResult,
} from '../src/run-scenario.js';

// Same skip/require pattern as `scenarios.test.ts` — see `sipInfraOrSkipReason`'s own comment.
const skipReason = await sipInfraOrSkipReason();

const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const REGISTRAR_CONTAINER = 'sip-test-carrier-registrar';
const REGISTRAR_PORT = 5080;

/**
 * S2-02's own acceptance test: "a SIPp 'carrier' registrar accepts a
 * registration from the platform, and trunk status shows registered."
 *
 * `carrier_registrar.xml` stands in for the carrier: it never sends the
 * first message (`uac_registrant` sends REGISTER on its own periodic
 * timer, driven by `OPENSIPS_REGISTRANT_TIMER_INTERVAL`, tuned fast in
 * `infra/compose/docker-compose.yml` for exactly this kind of test), so it
 * runs as a long-lived background UAS (`startBackgroundUas`), not the
 * short-lived foreground pattern the other scenarios use.
 */
describe.skipIf(skipReason !== undefined)('S2-02 trunk registration', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterAll(async () => {
    await stopContainer(REGISTRAR_CONTAINER);
  });

  it(
    'a register-mode trunk registers with a SIPp carrier registrar, and :status reports it',
    async () => {
      const registrar = startBackgroundUas('carrier_registrar.xml', REGISTRAR_CONTAINER, REGISTRAR_PORT);
      await registrar.ready();

      const created = await dockerCurlJson('POST', `${TRUNK_SERVICE_URL}/v1/tenants/${seed.tenantA.id}/trunks`, {
        name: 'S2-02 SIPp acceptance test',
        authMode: 'register',
        host: REGISTRAR_CONTAINER,
        port: REGISTRAR_PORT,
        transport: 'udp',
        username: 'sip-test-trunk-user',
        secret: 'sip-test-trunk-secret',
        codecs: ['PCMU'],
      });
      expect(created.status).toBe(201);
      const trunkId = (created.json as { id: string }).id;

      try {
        const status = await pollUntilRegistered(seed.tenantA.id, trunkId, 45_000);
        expect(status).toBe('registered');
      } finally {
        await dockerCurlJson('DELETE', `${TRUNK_SERVICE_URL}/v1/tenants/${seed.tenantA.id}/trunks/${trunkId}`);
      }
    },
    60_000,
  );
});

async function pollUntilRegistered(
  tenantId: string,
  trunkId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await dockerCurlJson(
      'GET',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}/status`,
    );
    const last =
      (response.json as { registrationStatus?: string } | undefined)?.registrationStatus ?? 'unknown';
    if (last === 'registered' || Date.now() > deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
