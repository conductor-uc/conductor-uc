import { randomBytes } from 'node:crypto';

import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { fileKekFromConfig, type KekProvider } from '@cuc/crypto';
import type { Bus } from '@cuc/events';
import { connectBus } from '@cuc/events';
import type { Logger } from '@cuc/logger';
import { silentLogger, startTestDatabase, startTestNats, type TestNatsHandle } from '@cuc/testing';

import {
  createEmergencyRouteRepo,
  type EmergencyRouteRepo,
} from '../src/repo/emergency-route.repo.js';
import {
  createOutboundRouteRepo,
  type OutboundRouteRepo,
} from '../src/repo/outbound-route.repo.js';
import { createTrunkRepo, type TrunkRepo } from '../src/repo/trunk.repo.js';
import type { TenantResellerLookup } from '../src/org-client.js';
import type { TrunkServiceDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';

export interface Harness {
  readonly db: Database<TrunkServiceDb>;
  readonly kek: KekProvider;
  readonly trunks: TrunkRepo;
  readonly outboundRoutes: OutboundRouteRepo;
  readonly emergencyRoutes: EmergencyRouteRepo;
  readonly resellers: FakeTenantResellers;
  readonly logger: Logger;
  close(): Promise<void>;
}

export interface FakeTenantResellers {
  readonly lookup: TenantResellerLookup;
  resellerIds: Record<string, string>;
}

const TEST_KEK = randomBytes(32).toString('base64');

/** A reseller lookup whose answers are set per test — no live org-service needed. */
function fakeTenantResellers(): FakeTenantResellers {
  const state: FakeTenantResellers = {
    resellerIds: {},
    lookup: (tenantId: string) => Promise.resolve(state.resellerIds[tenantId]),
  };
  return state;
}

/** A migrated schema, KEK, and trunk repo — no NATS. For repo/route tests. */
export async function startHarness(): Promise<Harness> {
  const logger = silentLogger();
  const handle = await startTestDatabase();

  const db = createDatabase<TrunkServiceDb>({
    host: handle.host,
    port: handle.port,
    user: handle.user,
    password: handle.password,
    database: handle.database,
    poolSize: 4,
    logger,
  });
  await migrateToLatest({ db: db.kysely, migrations, logger });

  const kek = fileKekFromConfig({ CRYPTO_KEKS: `1:${TEST_KEK}`, CRYPTO_KEK_CURRENT: '1' });
  const resellers = fakeTenantResellers();
  const trunks = createTrunkRepo(db, resellers.lookup, kek);
  const outboundRoutes = createOutboundRouteRepo(db);
  const emergencyRoutes = createEmergencyRouteRepo(db);

  return {
    db,
    kek,
    trunks,
    outboundRoutes,
    emergencyRoutes,
    resellers,
    logger,
    async close() {
      await db.destroy();
      await handle.stop();
    },
  };
}

export interface BusHarness extends Harness {
  readonly bus: Bus;
}

/** {@link startHarness} plus a real JetStream connection, for consumer/bus tests. */
export async function startBusHarness(): Promise<BusHarness> {
  const base = await startHarness();
  const natsHandle: TestNatsHandle = await startTestNats();
  const bus = await connectBus({
    servers: [natsHandle.server],
    logger: base.logger,
    name: 'trunk-service-test',
  });
  await bus.ensureStreams();

  return {
    ...base,
    bus,
    async close() {
      await bus.close();
      await natsHandle.stop();
      await base.close();
    },
  };
}

export async function resetSchema(db: Database<TrunkServiceDb>): Promise<void> {
  await db.kysely.deleteFrom('outbound_routes').execute();
  await db.kysely.deleteFrom('emergency_routes').execute();
  await db.kysely.deleteFrom('trunk_ips').execute();
  await db.kysely.deleteFrom('trunks').execute();
  await db.kysely.deleteFrom('outbox').execute();
  await db.kysely.deleteFrom('consumed_events').execute();
}
