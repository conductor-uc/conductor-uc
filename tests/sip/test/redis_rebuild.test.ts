import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  composeContainer,
  dockerCurlJson,
  fsCliAll,
  internalServiceHeaders,
  seedFixtures,
  sipInfraOrSkipReason,
  startDelayedCaller,
  startUas,
  stopContainer,
  withSingleFsNode,
  type SeedResult,
} from '../src/run-scenario.js';

const execFileAsync = promisify(execFile);
const skipReason = await sipInfraOrSkipReason();

const CALL_CONTROL_URL = 'http://call-control:8080';
const REDIS_CONTAINER = composeContainer('redis');
/** call-control's (and the nodes' shared) keyspace in the dev stack's Redis. */
const KEY_PREFIX = 'cuc:dev:';
const CALLER = 'sip-test-rebuild-801';
const PERSON = 'sip-test-rebuild-802';

interface LiveLeg {
  readonly callUuid: string;
  readonly state: string;
  readonly bridgedTo: string | null;
}

/**
 * S4-04, live (04 §5): Redis loses the registry in the middle of a call (every key in
 * call-control's keyspace is deleted), and within 30 s the call is back in the live list, read
 * from the node, answered and bridged as it was.
 */
describe.skipIf(skipReason !== undefined)('S4-04 Redis loses the registry (live)', () => {
  let seed: SeedResult;
  let tenantId: string;
  let fqdn: string;

  beforeAll(async () => {
    seed = await seedFixtures();
    tenantId = seed.tenantCalls.id;
    fqdn = seed.tenantCalls.fqdn;
  }, 120_000);

  afterEach(async () => {
    await Promise.all([CALLER, PERSON].map((name) => stopContainer(name)));
  });

  function password(number: string): string {
    const entry = seed.extensions[`${fqdn}/${number}`];
    if (entry === undefined) throw new Error(`no seeded extension ${number}`);
    return entry.password;
  }

  async function legs(): Promise<LiveLeg[]> {
    const response = await dockerCurlJson(
      'GET',
      `${CALL_CONTROL_URL}/internal/v1/tenants/${tenantId}/calls`,
      undefined,
      internalServiceHeaders(),
    );
    return (response.json as { calls?: LiveLeg[] }).calls ?? [];
  }

  async function loseRegistry(): Promise<number> {
    const { stdout } = await execFileAsync('docker', [
      'exec',
      REDIS_CONTAINER,
      'sh',
      '-c',
      `redis-cli --scan --pattern '${KEY_PREFIX}*' | xargs -r redis-cli del`,
    ]);
    return Number(stdout.trim() || '0');
  }

  it('reads the live call back from the node within 30 s', async () => {
    await withSingleFsNode(async () => {
      for (const number of ['801', '802']) await clearRegistration(`${number}@${fqdn}`);
      const person = startUas({
        au: '802',
        ap: password('802'),
        authUri: fqdn,
        csvLine: `802;${fqdn}`,
        containerName: PERSON,
      });
      await person.ready();
      const caller = await startDelayedCaller({
        scenario: 'uac_call_hold_long.xml',
        csvLine: `801;${fqdn};802`,
        au: '801',
        ap: password('801'),
        authUri: fqdn,
        containerName: CALLER,
      });

      let before: LiveLeg[] = [];
      await expect
        .poll(
          async () => {
            before = (await legs()).filter((leg) => leg.state === 'answered');
            return before.length;
          },
          { timeout: 30_000, interval: 500 },
        )
        .toBeGreaterThanOrEqual(2);

      expect(await loseRegistry()).toBeGreaterThan(0);
      const lostAt = Date.now();
      expect(await legs()).toEqual([]);

      let after: LiveLeg[] = [];
      await expect
        .poll(
          async () => {
            after = await legs();
            return before.every((leg) => after.some((back) => back.callUuid === leg.callUuid));
          },
          { timeout: 30_000, interval: 500 },
        )
        .toBe(true);
      const back = (Date.now() - lostAt) / 1000;
      // Both legs answered and bridged to each other, as the node has them.
      const ids = before.map((leg) => leg.callUuid);
      for (const id of ids) {
        const again = after.find((candidate) => candidate.callUuid === id);
        expect(again?.state).toBe('answered');
        expect(ids).toContain(again?.bridgedTo);
      }
      // eslint-disable-next-line no-console
      console.log(`S4-04: the registry was back ${back.toFixed(1)} s after Redis lost it`);

      await fsCliAll('hupall NORMAL_CLEARING');
      await Promise.all([caller.result(), person.result()]);
    });
  }, 120_000);
});
