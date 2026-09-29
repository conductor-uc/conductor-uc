import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { createDatabase, migrateToLatest } from '@cuc/db';
import { connectBus, type Bus, type EventEnvelope } from '@cuc/events';
import { silentLogger } from '@cuc/testing';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const logger = silentLogger();

const PROJECT = process.env['HA_PROJECT'] ?? 'cuc-data-ha';
const LB_HOST = process.env['HA_LB_HOST'] ?? '127.0.0.1';
const DB_PORT = Number(process.env['HA_DB_PORT'] ?? '13306');
const DB_PASSWORD = process.env['HA_DB_ROOT_PASSWORD'] ?? 'dev-root-password';
const REDIS_PORT = Number(process.env['HA_REDIS_PORT'] ?? '16379');
const NATS_SERVERS = (
  process.env['HA_NATS_SERVERS'] ?? '127.0.0.1:14222,127.0.0.1:14223,127.0.0.1:14224'
).split(',');
const REPO = new URL('../../../', import.meta.url).pathname;
/** Every service with a schema of its own. */
const SERVICES = [
  'call-control',
  'callflow-service',
  'cdr-service',
  'identity-service',
  'media-worker',
  'notification-service',
  'org-service',
  'pbx-config-service',
  'recording-service',
  'telephony-config',
  'trunk-service',
  'voicemail-service',
];

const container = (service: string) => `${PROJECT}-${service}-1`;

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args);
  return stdout.trim();
}

async function running(): Promise<boolean> {
  try {
    return (await docker('inspect', '-f', '{{.State.Running}}', container('haproxy'))) === 'true';
  } catch {
    return false;
  }
}

const skip = process.env['REQUIRE_DATA_HA_TESTS'] !== '1' && !(await running());

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (
      await Promise.resolve()
        .then(check)
        .catch(() => false)
    )
      return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** A loop doing one write every 50 ms, recording when each succeeded. */
function writer(write: () => Promise<void>) {
  const ok: number[] = [];
  let failures = 0;
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      try {
        await write();
        ok.push(Date.now());
      } catch {
        failures += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  return {
    ok,
    failures: () => failures,
    /** The longest stretch without a successful write from `from` on, in seconds. */
    gapAfter(from: number): number {
      const before = ok.filter((at) => at < from).at(-1) ?? from;
      const after = ok.find((at) => at > from);
      return after === undefined ? Infinity : (after - before) / 1000;
    },
    async stop() {
      stopped = true;
      await done;
    },
  };
}

/**
 * S4-07, live (10 §4, D-016): the data tier the services use in production, run as its own
 * compose project (`infra/data-ha`), with each part failed over while writes go on through the
 * libraries the services use: `@cuc/db`'s pool through the load balancer's MariaDB writer,
 * ioredis through its Redis primary, and `@cuc/events`' bus against the three NATS servers.
 */
describe.skipIf(skip)('S4-07 the highly available data tier (live)', () => {
  const galeraMembers = ['galera-1', 'galera-2', 'galera-3'];

  async function galeraSql(member: string, query: string): Promise<string> {
    return docker(
      'exec',
      container(member),
      'mariadb',
      '-uroot',
      `-p${DB_PASSWORD}`,
      '-N',
      '-B',
      '-e',
      query,
    );
  }

  async function synced(member: string): Promise<boolean> {
    const state = await galeraSql(
      member,
      "SHOW STATUS WHERE Variable_name IN ('wsrep_local_state_comment','wsrep_cluster_size')",
    );
    return state.includes('Synced') && /wsrep_cluster_size\s+3/.test(state);
  }

  beforeAll(async () => {
    await waitFor(
      async () => (await Promise.all(galeraMembers.map(synced))).every(Boolean),
      180_000,
      'Galera',
    );
  });

  it("runs every service's migrations on Galera, and every table has a primary key", async () => {
    const root = createDatabase({
      host: LB_HOST,
      port: DB_PORT,
      user: 'root',
      password: DB_PASSWORD,
      database: 'mysql',
      logger,
    });
    try {
      for (const service of SERVICES) {
        const dir = `${REPO}services/${service}/dist/migrations`;
        expect(existsSync(dir), `${service} is not built`).toBe(true);
        const schema = `ha_${service.replaceAll('-', '_')}`;
        await sql.raw(`DROP DATABASE IF EXISTS ${schema}`).execute(root.kysely);
        await sql.raw(`CREATE DATABASE ${schema}`).execute(root.kysely);
        const db = createDatabase({
          host: LB_HOST,
          port: DB_PORT,
          user: 'root',
          password: DB_PASSWORD,
          database: schema,
          logger,
        });
        try {
          await migrateToLatest({ db: db.kysely, dir, logger });
        } finally {
          await db.destroy();
        }
      }
      const withoutKey = await sql<{ table_schema: string; table_name: string }>`
        SELECT t.table_schema, t.table_name FROM information_schema.tables t
        WHERE t.table_schema LIKE 'ha\\_%' AND t.table_type = 'BASE TABLE'
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints c
            WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name
              AND c.constraint_type = 'PRIMARY KEY')`.execute(root.kysely);
      expect(withoutKey.rows).toEqual([]);
    } finally {
      await root.destroy();
    }
  });

  it('moves writes to another member when the writer dies, and the writer rejoins with every write', async () => {
    const root = createDatabase({
      host: LB_HOST,
      port: DB_PORT,
      user: 'root',
      password: DB_PASSWORD,
      database: 'mysql',
      logger,
    });
    await sql`CREATE DATABASE IF NOT EXISTS ha_probe`.execute(root.kysely);
    await sql`CREATE TABLE IF NOT EXISTS ha_probe.writes (id BIGINT AUTO_INCREMENT PRIMARY KEY, run VARCHAR(36) NOT NULL)`.execute(
      root.kysely,
    );
    const run = randomUUID();
    const loop = writer(async () => {
      await sql`INSERT INTO ha_probe.writes (run) VALUES (${run})`.execute(root.kysely);
    });
    let killed: string | undefined;
    try {
      await waitFor(() => loop.ok.length >= 10, 10_000, 'the first writes');
      const writerHost = (
        await sql<{ host: string }>`SELECT @@hostname AS host`.execute(root.kysely)
      ).rows[0]?.host;
      expect(galeraMembers).toContain(writerHost);
      killed = writerHost!;
      const killedAt = Date.now();
      await docker('kill', container(killed));
      await waitFor(() => loop.ok.some((at) => at > killedAt + 1_000), 30_000, 'writes again');
      const gap = loop.gapAfter(killedAt);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await loop.stop();
      expect(gap).toBeLessThan(10);
      // eslint-disable-next-line no-console
      console.log(`S4-07: MariaDB writes paused ${gap.toFixed(1)} s when the writer died`);

      // Every acknowledged write is on both survivors.
      const survivors = galeraMembers.filter((member) => member !== killed);
      for (const member of survivors) {
        const count = Number(
          await galeraSql(member, `SELECT COUNT(*) FROM ha_probe.writes WHERE run = '${run}'`),
        );
        expect(count, member).toBeGreaterThanOrEqual(loop.ok.length);
      }
      const expected = await galeraSql(
        survivors[0]!,
        `SELECT COUNT(*) FROM ha_probe.writes WHERE run = '${run}'`,
      );

      // The dead member comes back, rejoins, and catches up.
      await docker('start', container(killed));
      await waitFor(() => synced(killed!), 180_000, `${killed} to rejoin`);
      expect(
        await galeraSql(killed, `SELECT COUNT(*) FROM ha_probe.writes WHERE run = '${run}'`),
      ).toBe(expected);
    } finally {
      await loop.stop();
      if (killed !== undefined) await docker('start', container(killed)).catch(() => undefined);
      await root.destroy();
    }
  });

  it('follows Sentinel to the new Redis primary, and the old one returns as a replica', async () => {
    const redisMembers = ['redis-1', 'redis-2', 'redis-3'];
    const redis = new Redis({ host: LB_HOST, port: REDIS_PORT, maxRetriesPerRequest: 1 });
    redis.on('error', () => undefined);
    const key = `ha:${randomUUID()}`;
    await redis.set(`${key}:before`, 'kept');
    // Replicated to both replicas before the primary dies.
    expect(await redis.wait(2, 2_000)).toBe(2);
    const loop = writer(async () => {
      await redis.incr(`${key}:count`);
    });
    let killed: string | undefined;
    try {
      await waitFor(() => loop.ok.length >= 10, 10_000, 'the first writes');
      for (const member of redisMembers) {
        const role = await docker('exec', container(member), 'redis-cli', 'role');
        if (role.startsWith('master')) killed = member;
      }
      expect(killed).toBeDefined();
      const killedAt = Date.now();
      await docker('kill', container(killed!));
      await waitFor(() => loop.ok.some((at) => at > killedAt + 1_000), 60_000, 'writes again');
      const gap = loop.gapAfter(killedAt);
      await loop.stop();
      expect(gap).toBeLessThan(15);
      expect(await redis.get(`${key}:before`)).toBe('kept');
      // eslint-disable-next-line no-console
      console.log(`S4-07: Redis writes paused ${gap.toFixed(1)} s when the primary died`);

      await docker('start', container(killed!));
      await waitFor(
        async () =>
          (await docker('exec', container(killed!), 'redis-cli', 'role')).startsWith('slave'),
        60_000,
        `${killed} to return as a replica`,
      );
    } finally {
      await loop.stop();
      if (killed !== undefined) await docker('start', container(killed)).catch(() => undefined);
      redis.disconnect();
    }
  });

  describe('NATS', () => {
    let bus: Bus;

    beforeAll(async () => {
      bus = await connectBus({
        servers: NATS_SERVERS,
        logger,
        name: 'tests-data-ha',
        streamReplicas: 3,
      });
      await bus.ensureStreams();
    });

    afterAll(async () => {
      await bus?.close();
    });

    function envelope(): EventEnvelope {
      return {
        id: randomUUID(),
        type: 'call.channel.hungup',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        orgContext: {},
        data: { probe: true },
      };
    }

    it('keeps three copies of every stream, and publishing survives the loss of the leader', async () => {
      const info = await bus.jsm.streams.info('CALL');
      expect(info.config.num_replicas).toBe(3);
      expect(info.cluster?.replicas ?? []).toHaveLength(2);
      const leader = info.cluster?.leader;
      expect(leader).toMatch(/^nats-[123]$/);
      const first = await bus.publish(envelope());

      const killedAt = Date.now();
      await docker('kill', container(leader!));
      let published: { sequence: number } | undefined;
      await waitFor(
        async () => {
          published = await bus.publish(envelope());
          return true;
        },
        30_000,
        'a publish after the leader died',
      );
      const gap = (Date.now() - killedAt) / 1000;
      expect(published!.sequence).toBeGreaterThan(first.sequence);
      // The message from before the loss is still there.
      const kept = await bus.jsm.streams.getMessage('CALL', { seq: first.sequence });
      expect(kept?.seq).toBe(first.sequence);
      // eslint-disable-next-line no-console
      console.log(
        `S4-07: NATS publishing resumed ${gap.toFixed(1)} s after the stream leader died`,
      );

      await docker('start', container(leader!));
      await waitFor(
        async () => {
          const after = await bus.jsm.streams.info('CALL');
          return (after.cluster?.replicas ?? []).every((replica) => replica.current);
        },
        60_000,
        `${leader} to catch up`,
      );
    });
  });
});
