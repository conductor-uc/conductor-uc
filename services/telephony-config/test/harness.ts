import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import type { Bus } from '@cuc/events';
import { connectBus } from '@cuc/events';
import type { Logger } from '@cuc/logger';
import { silentLogger, startTestDatabase, startTestNats, type TestNatsHandle } from '@cuc/testing';

import type { OrgClient } from '../src/org-client.js';
import type { DidConfig, DigestCredential, PbxConfigClient } from '../src/pbx-config-client.js';
import type { OpenSipsMiClient } from '../src/opensips-mi-client.js';
import type { OpenSipsDb } from '../src/opensips-schema.js';
import { createProjection, type Projection } from '../src/projection.js';
import {
  createOpenSipsProjectionRepo,
  type OpenSipsProjectionRepo,
} from '../src/repo/opensips-projection.repo.js';
import { createReadModelRepo, type ReadModelRepo } from '../src/repo/read-model.repo.js';
import type { TelephonyConfigDb } from '../src/schema.js';
import type {
  OutboundRouteConfig,
  TrunkConfig,
  TrunkConfigClient,
} from '../src/trunk-config-client.js';
import { migrations } from '../migrations/index.js';

/** OpenSIPs' own SIP URI, as `config.ts`'s `OPENSIPS_SIP_URI` would carry it. */
export const TEST_OPENSIPS_SIP_URI = 'opensips-test:5060';

export interface Harness {
  readonly db: Database<TelephonyConfigDb>;
  readonly opensipsDb: Database<OpenSipsDb>;
  readonly readModel: ReadModelRepo;
  readonly opensipsProjection: OpenSipsProjectionRepo;
  readonly projection: Projection;
  readonly mi: FakeMiClient;
  readonly pbxConfig: FakePbxConfigClient;
  readonly trunkConfig: FakeTrunkConfigClient;
  readonly orgClient: FakeOrgClient;
  readonly logger: Logger;
  close(): Promise<void>;
}

export interface FakeMiClient extends OpenSipsMiClient {
  readonly calls: string[];
  /** `reg_list`'s canned answer, keyed by the `aor` positional param — set per test. */
  regListResults: Record<string, unknown>;
}

/** Records every reload call rather than needing a real OpenSIPs; `query('reg_list', ...)` answers from `regListResults`. */
function fakeMiClient(): FakeMiClient {
  const calls: string[] = [];
  const state: FakeMiClient = {
    calls,
    regListResults: {},
    call(method: string) {
      calls.push(method);
      return Promise.resolve();
    },
    query<T>(method: string, params?: readonly unknown[]) {
      calls.push(method);
      if (method === 'reg_list') {
        const aor = typeof params?.[0] === 'string' ? params[0] : '';
        return Promise.resolve((state.regListResults[aor] ?? { Records: [] }) as T);
      }
      return Promise.resolve(undefined as T);
    },
  };
  return state;
}

export interface FakePbxConfigClient extends PbxConfigClient {
  credentials: Record<string, DigestCredential>;
  dids: Record<string, DidConfig>;
}

/** A digest-credential/DID lookup whose answers are set per test — no live pbx-config-service needed. */
function fakePbxConfigClient(): FakePbxConfigClient {
  const state: FakePbxConfigClient = {
    credentials: {},
    dids: {},
    findCredential: (_tenantId: string, extensionId: string) =>
      Promise.resolve(state.credentials[extensionId]),
    findDid: (_tenantId: string, didId: string) => Promise.resolve(state.dids[didId]),
  };
  return state;
}

export interface FakeTrunkConfigClient extends TrunkConfigClient {
  trunks: Record<string, TrunkConfig>;
  outboundRoutes: Record<string, OutboundRouteConfig>;
}

/** A trunk-config/outbound-route lookup whose answers are set per test — no live trunk-service needed. */
function fakeTrunkConfigClient(): FakeTrunkConfigClient {
  const state: FakeTrunkConfigClient = {
    trunks: {},
    outboundRoutes: {},
    findTrunk: (_tenantId: string, trunkId: string) => Promise.resolve(state.trunks[trunkId]),
    listAllTrunks: () => Promise.resolve(Object.values(state.trunks)),
    findOutboundRoute: (_tenantId: string, outboundRouteId: string) =>
      Promise.resolve(state.outboundRoutes[outboundRouteId]),
    listAllOutboundRoutes: () => Promise.resolve(Object.values(state.outboundRoutes)),
  };
  return state;
}

export interface FakeOrgClient extends OrgClient {
  countries: Record<string, string>;
  limits: Record<string, Record<string, unknown>>;
}

/** A tenant-country/limits lookup whose answers are set per test — no live org-service needed. */
function fakeOrgClient(): FakeOrgClient {
  const state: FakeOrgClient = {
    countries: {},
    limits: {},
    findCountry: (tenantId: string) => Promise.resolve(state.countries[tenantId]),
    findLimits: (tenantId: string) => Promise.resolve(state.limits[tenantId]),
  };
  return state;
}

/**
 * Creates `domain`, `subscriber`, `registrant`, `address`, `dr_gateways`,
 * and `dr_rules` exactly as OpenSIPs' own vendored schema does
 * (`telephony/opensips/db-schema/{domain,auth_db,registrant,permissions,
 * drouting}-create.sql`), minus bookkeeping columns/tables this service
 * never reads or writes — only column shapes matter here, and a real
 * MariaDB, not a mock, verifies this service's actual SQL against them.
 */
async function createOpenSipsTables(db: Database<OpenSipsDb>): Promise<void> {
  await db.kysely.schema
    .createTable('domain')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('domain', 'char(64)', (col) => col.notNull().defaultTo(''))
    .addColumn('attrs', 'char(255)')
    .addColumn('accept_subdomain', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_modified', 'datetime', (col) => col.notNull())
    .execute();
  await db.kysely.schema.createIndex('domain_idx').on('domain').column('domain').unique().execute();

  await db.kysely.schema
    .createTable('subscriber')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('username', 'char(64)', (col) => col.notNull().defaultTo(''))
    .addColumn('domain', 'char(64)', (col) => col.notNull().defaultTo(''))
    .addColumn('password', 'char(25)', (col) => col.notNull().defaultTo(''))
    .addColumn('ha1', 'char(64)', (col) => col.notNull().defaultTo(''))
    .addColumn('ha1_sha256', 'char(64)', (col) => col.notNull().defaultTo(''))
    .addColumn('ha1_sha512t256', 'char(64)', (col) => col.notNull().defaultTo(''))
    .execute();
  await db.kysely.schema
    .createIndex('account_idx')
    .on('subscriber')
    .columns(['username', 'domain'])
    .unique()
    .execute();

  await db.kysely.schema
    .createTable('registrant')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('registrar', 'char(255)', (col) => col.notNull().defaultTo(''))
    .addColumn('proxy', 'char(255)')
    .addColumn('aor', 'char(255)', (col) => col.notNull().defaultTo(''))
    .addColumn('third_party_registrant', 'char(255)')
    .addColumn('username', 'char(64)')
    .addColumn('password', 'char(64)')
    .addColumn('binding_uri', 'char(255)', (col) => col.notNull().defaultTo(''))
    .addColumn('binding_params', 'char(64)')
    .addColumn('expiry', 'integer')
    .addColumn('forced_socket', 'char(64)')
    .addColumn('cluster_shtag', 'char(64)')
    .addColumn('state', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
  await db.kysely.schema
    .createIndex('registrant_idx')
    .on('registrant')
    .columns(['aor', 'binding_uri', 'registrar'])
    .unique()
    .execute();

  await db.kysely.schema
    .createTable('address')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('grp', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('ip', 'char(50)', (col) => col.notNull())
    .addColumn('mask', 'integer', (col) => col.notNull().defaultTo(32))
    .addColumn('port', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('proto', 'char(4)', (col) => col.notNull().defaultTo('any'))
    .addColumn('pattern', 'char(64)')
    .addColumn('context_info', 'char(32)')
    .execute();

  await db.kysely.schema
    .createTable('dr_gateways')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('gwid', 'char(64)', (col) => col.notNull())
    .addColumn('type', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('address', 'char(128)', (col) => col.notNull())
    .addColumn('strip', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('pri_prefix', 'char(16)')
    .addColumn('attrs', 'char(255)')
    .addColumn('probe_mode', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('state', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('socket', 'char(128)')
    .addColumn('description', 'char(128)')
    .execute();
  await db.kysely.schema
    .createIndex('dr_gw_idx')
    .on('dr_gateways')
    .column('gwid')
    .unique()
    .execute();

  await db.kysely.schema
    .createTable('dr_rules')
    .addColumn('ruleid', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('groupid', 'char(255)', (col) => col.notNull())
    .addColumn('prefix', 'char(64)', (col) => col.notNull())
    .addColumn('timerec', 'char(255)')
    .addColumn('priority', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('routeid', 'char(255)')
    .addColumn('gwlist', 'char(255)')
    .addColumn('sort_alg', 'char(1)', (col) => col.notNull().defaultTo('N'))
    .addColumn('sort_profile', 'integer')
    .addColumn('attrs', 'char(255)')
    .addColumn('description', 'char(128)')
    .execute();
}

/** A migrated read-model schema, a fake `opensips` schema, and the repos over both. */
export async function startHarness(): Promise<Harness> {
  const logger = silentLogger();

  const handle = await startTestDatabase();
  const db = createDatabase<TelephonyConfigDb>({
    host: handle.host,
    port: handle.port,
    user: handle.user,
    password: handle.password,
    database: handle.database,
    poolSize: 4,
    logger,
  });
  await migrateToLatest({ db: db.kysely, migrations, logger });

  const opensipsHandle = await startTestDatabase();
  const opensipsDb = createDatabase<OpenSipsDb>({
    host: opensipsHandle.host,
    port: opensipsHandle.port,
    user: opensipsHandle.user,
    password: opensipsHandle.password,
    database: opensipsHandle.database,
    poolSize: 4,
    logger,
  });
  await createOpenSipsTables(opensipsDb);

  const readModel = createReadModelRepo(db);
  const opensipsProjection = createOpenSipsProjectionRepo(opensipsDb);
  const mi = fakeMiClient();
  const pbxConfig = fakePbxConfigClient();
  const trunkConfig = fakeTrunkConfigClient();
  const orgClient = fakeOrgClient();
  const projection = createProjection(
    readModel,
    opensipsProjection,
    mi,
    pbxConfig,
    logger,
    trunkConfig,
    TEST_OPENSIPS_SIP_URI,
  );

  return {
    db,
    opensipsDb,
    readModel,
    opensipsProjection,
    projection,
    mi,
    pbxConfig,
    trunkConfig,
    orgClient,
    logger,
    async close() {
      await db.destroy();
      await handle.stop();
      await opensipsDb.destroy();
      await opensipsHandle.stop();
    },
  };
}

export interface BusHarness extends Harness {
  readonly bus: Bus;
}

/** {@link startHarness} plus a real JetStream connection, for consumer tests. */
export async function startBusHarness(): Promise<BusHarness> {
  const base = await startHarness();
  const natsHandle: TestNatsHandle = await startTestNats();
  const bus = await connectBus({
    servers: [natsHandle.server],
    logger: base.logger,
    name: 'telephony-config-test',
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

export async function resetSchema(db: Database<TelephonyConfigDb>): Promise<void> {
  await db.kysely.deleteFrom('dids').execute();
  await db.kysely.deleteFrom('outbound_routes').execute();
  await db.kysely.deleteFrom('trunk_ips').execute();
  await db.kysely.deleteFrom('trunks').execute();
  await db.kysely.deleteFrom('extensions').execute();
  await db.kysely.deleteFrom('domains').execute();
  await db.kysely.deleteFrom('tenant_dr_groups').execute();
  await db.kysely.deleteFrom('tenants').execute();
  await db.kysely.deleteFrom('outbox').execute();
  await db.kysely.deleteFrom('consumed_events').execute();
}

export async function resetOpenSipsSchema(db: Database<OpenSipsDb>): Promise<void> {
  await db.kysely.deleteFrom('subscriber').execute();
  await db.kysely.deleteFrom('domain').execute();
  await db.kysely.deleteFrom('registrant').execute();
  await db.kysely.deleteFrom('address').execute();
  await db.kysely.deleteFrom('dr_rules').execute();
  await db.kysely.deleteFrom('dr_gateways').execute();
}
