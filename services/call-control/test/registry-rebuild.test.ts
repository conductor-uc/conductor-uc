import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, redisOrSkipReason } from '@cuc/testing';

import { createRegistryRebuild, type RebuildEsl } from '../src/registry-rebuild.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await redisOrSkipReason());

/** A node with two answered legs bridged to each other, as `show channels` and `uuid_dump` answer. */
function fakeNode(tenantId: string, a: string, b: string) {
  const commands: string[] = [];
  const dump = (uuid: string, other: string, direction: string, from: string, to: string) => ({
    'Unique-ID': uuid,
    'Call-Direction': direction,
    'Caller-Caller-ID-Number': from,
    'Caller-Destination-Number': to,
    'Caller-Channel-Created-Time': '1790000000123000',
    'Caller-Channel-Answered-Time': '1790000002000000',
    'Channel-Call-State': 'ACTIVE',
    'Other-Leg-Unique-ID': other,
    variable_cuc_tenant_id: tenantId,
    variable_sip_call_id: `${uuid}@edge`,
  });
  const dumps: Record<string, Record<string, string>> = {
    [a]: dump(a, b, 'inbound', '+15550001111', '1001'),
    [b]: dump(b, a, 'outbound', '+15550001111', '1001'),
  };
  const esl: RebuildEsl = {
    sendApi(command) {
      commands.push(command);
      if (command === 'show channels as json') {
        return Promise.resolve({
          ok: true,
          body: JSON.stringify({ row_count: 2, rows: [{ uuid: a }, { uuid: b }] }),
        });
      }
      const uuid = /^uuid_dump (\S+) json$/.exec(command)?.[1];
      const found = uuid === undefined ? undefined : dumps[uuid];
      return Promise.resolve(
        found === undefined
          ? { ok: false, body: '-ERR No such channel!' }
          : { ok: true, body: JSON.stringify(found) },
      );
    },
  };
  return { esl, commands };
}

describe.skipIf(skipReason !== undefined)(
  'rebuilding the registry after Redis loses it (S4-04)',
  () => {
    let h: Harness;
    let restores = 0;

    beforeAll(async () => {
      h = await startHarness();
    });

    afterAll(async () => {
      await h?.close();
    });

    it('reads every live call back from the nodes, once, and sets the leases again when the data goes', async () => {
      const tenantId = crypto.randomUUID();
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      const node = fakeNode(tenantId, a, b);
      const rebuild = createRegistryRebuild({
        registry: h.registry,
        affinity: {
          restore: () => {
            restores += 1;
            return Promise.resolve(0);
          },
        },
        nodes: () => new Map([['fs-1', node.esl]]),
        callSafetyTtlMs: 60_000,
        logger: h.logger,
      });

      // A fresh registry has no epoch: it is rebuilt from the node.
      expect(await rebuild.runOnce()).toBe(2);
      expect(await h.registry.getCall(a)).toMatchObject({
        node: 'fs-1',
        tenant: tenantId,
        state: 'answered',
        answeredAt: '1790000002000',
        startedAt: '1790000000123',
        bridgedTo: b,
        sipCallId: `${a}@edge`,
      });
      expect((await h.registry.callsForTenant(tenantId)).map((c) => c.callUuid).sort()).toEqual(
        [a, b].sort(),
      );

      // Nothing lost since: nothing to do, and the node is not asked again.
      const asked = node.commands.length;
      expect(await rebuild.runOnce()).toBe(0);
      expect(node.commands).toHaveLength(asked);
      expect(restores).toBe(0);

      // Redis loses its data; a call live events already recreated is left as it is.
      await h.redis.del(`${h.keyPrefix}registry:epoch`, `${h.keyPrefix}call:${b}`);
      await h.registry.updateCall(a, { state: 'held' });
      expect(await rebuild.runOnce()).toBe(1);
      expect(await h.registry.getCall(a)).toMatchObject({ state: 'held' });
      expect(await h.registry.getCall(b)).toMatchObject({ state: 'answered', bridgedTo: a });
      expect(restores).toBe(1);
    });
  },
);
