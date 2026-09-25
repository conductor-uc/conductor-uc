import { randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FileKekProvider, keyVersionOf } from '@cuc/crypto';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';

import { createKekRewrapJob, ENCRYPTED_COLUMNS } from '../src/kek-rewrap.js';
import { createTrunkRepo } from '../src/repo/trunk.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();

const KEY_1 = randomBytes(32);
const KEY_2 = randomBytes(32);

/** Before the operator adds a key: version 1 only. */
const before = new FileKekProvider({ keys: { '1': KEY_1 }, currentVersion: '1' });
/** After: both listed, version 2 current. */
const during = new FileKekProvider({ keys: { '1': KEY_1, '2': KEY_2 }, currentVersion: '2' });
/** Once every service reports 0: version 1 removed. */
const after = new FileKekProvider({ keys: { '2': KEY_2 }, currentVersion: '2' });

const input = (name: string) => ({
  name,
  authMode: 'register' as const,
  host: 'sip.carrier.test',
  port: 5060,
  transport: 'udp',
  username: 'trunkuser',
  secret: `secret-of-${name}`,
  fromDomain: 'acme.platform.test',
  codecs: ['PCMU'],
});

describe.skipIf(skipReason !== undefined)('KEK re-wrap (trunk-service)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    h.resellers.resellerIds = {};
  });

  it('covers the trunk credential column', () => {
    expect(ENCRYPTED_COLUMNS).toEqual([{ table: 'trunks', idColumn: 'id', column: 'secret_enc' }]);
  });

  it('moves every trunk secret from version 1 to 2, and they still decrypt without version 1', async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    h.resellers.resellerIds[tenantA] = 'reseller-a';
    h.resellers.resellerIds[tenantB] = 'reseller-b';

    const oldRepo = createTrunkRepo(h.db, h.resellers.lookup, before);
    const created = [
      { tenantId: tenantA, trunk: await oldRepo.create({ tenantId: tenantA }, input('a1')) },
      { tenantId: tenantA, trunk: await oldRepo.create({ tenantId: tenantA }, input('a2')) },
      { tenantId: tenantB, trunk: await oldRepo.create({ tenantId: tenantB }, input('b1')) },
    ];
    // An IP-authenticated trunk has no secret at all; it must be left alone.
    await oldRepo.create(
      { tenantId: tenantB },
      {
        name: 'ip-only',
        authMode: 'ip',
        host: 'sip.carrier.test',
        port: 5060,
        transport: 'udp',
        fromDomain: 'acme.platform.test',
        codecs: ['PCMU'],
      },
    );

    const job = createKekRewrapJob(h.db, during, silentLogger(), 2);
    const result = await job.runOnce();

    expect(result).toEqual({ rewrapped: 3, skipped: 0, failed: 0, remaining: 0 });
    expect(await job.readinessCheck()).toEqual({
      status: 'pass',
      detail: '0 values under older key versions',
    });

    const rows = await h.db.kysely.selectFrom('trunks').select(['name', 'secret_enc']).execute();
    for (const row of rows) {
      if (row.name === 'ip-only') expect(row.secret_enc).toBeNull();
      else expect(keyVersionOf(row.secret_enc!)).toBe('2');
    }

    // Version 1 removed from the configuration: every secret still reads back,
    // under its original associated data (tenant and trunk id).
    const newRepo = createTrunkRepo(h.db, h.resellers.lookup, after);
    for (const { tenantId, trunk } of created) {
      const revealed = await newRepo.reveal({ tenantId }, trunk.id);
      expect(revealed.secret).toBe(`secret-of-${trunk.name}`);
    }
  });

  it('reports what is left while a value cannot be re-wrapped yet', async () => {
    const tenantId = crypto.randomUUID();
    h.resellers.resellerIds[tenantId] = 'reseller-a';
    await createTrunkRepo(h.db, h.resellers.lookup, before).create({ tenantId }, input('x'));

    // Version 1 dropped too early: the value cannot be unwrapped, so it stays and is counted.
    const job = createKekRewrapJob(h.db, after, silentLogger());
    const result = await job.runOnce();

    expect(result).toMatchObject({ rewrapped: 0, failed: 1, remaining: 1 });
    expect(await job.readinessCheck()).toEqual({
      status: 'pass',
      detail: '1 values under older key versions',
    });
  });
});
