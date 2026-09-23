/**
 * S1-14: provisions the fixtures `tests/sip`'s SIPp scenarios dial against.
 *
 * Deliberately bypasses org-service's own `POST /v1/.../tenants` HTTP route
 * (which also creates an admin user through identity-service, D-014) and
 * pbx-config-service's `POST /v1/.../extensions` route — this suite tests
 * SIP behavior (registration, calls, tenant isolation), not the
 * provisioning API surface or auth stack, so it calls each service's own
 * repo layer directly against the real compose database, the same
 * `bootstrap-master`-style direct-repo pattern org-service's own CLI
 * already uses (`src/cli/bootstrap-master.ts`). org-service and
 * pbx-config-service still run as real, live containers: this only skips
 * their HTTP layer, not their outbox relays or NATS consumers, so
 * `org.tenant.created`/`org.domain.added`/`pbx.extension.created` are real
 * events telephony-config really projects into OpenSIPs — nothing here is
 * pre-seeded into the `opensips` schema directly.
 *
 * Safe to re-run: every create is caught for "already exists" and resolved
 * to the existing row instead of failing the whole script.
 */
import { createDatabase, type Database } from '@cuc/db';
import { fileKekFromConfig } from '@cuc/crypto';
import { createLogger } from '@cuc/logger';

import {
  createOrgRepo,
  MasterAlreadyExistsError,
  SlugTakenError,
  type Org,
} from '@cuc/org-service/dist/src/repo/org.repo.js';
import type { OrgServiceDb } from '@cuc/org-service/dist/src/schema.js';
import { createOrgClient } from '@cuc/pbx-config-service/dist/src/org-client.js';
import { createEmergencyLocationRepo } from '@cuc/pbx-config-service/dist/src/repo/emergency-location.repo.js';
import {
  createExtensionRepo,
  ExtensionNumberTakenError,
} from '@cuc/pbx-config-service/dist/src/repo/extension.repo.js';
import type { PbxConfigServiceDb } from '@cuc/pbx-config-service/dist/src/schema.js';

export interface SeedResult {
  readonly resellerId: string;
  readonly tenantA: { readonly id: string; readonly fqdn: string };
  readonly tenantB: { readonly id: string; readonly fqdn: string };
  readonly tenantSuspended: { readonly id: string; readonly fqdn: string };
  /**
   * S2-04: a tenant created fresh by *this* run, not reused across sessions
   * like `tenantA`/`tenantB` — outbound dialing needs telephony-config's own
   * `tenants.country` (migration `005_add_outbound_routing`), which is only
   * ever set by consuming a live `org.tenant.created` event (`org.consumer.ts`;
   * there is no backfill for a tenant whose event was consumed before that
   * migration existed, a documented gap). `tenantA`/`tenantB` predate it in
   * every environment this suite has ever run against, so their local mirror
   * row's `country` is permanently `NULL` — a fresh tenant is the only way to
   * get a real one.
   */
  readonly tenantOutbound: { readonly id: string; readonly fqdn: string };
  /**
   * S2-05: a tenant dedicated to toll-fraud-control tests, kept separate
   * from `tenantOutbound` (S2-04's own outbound-failover test) even though
   * both need a real country — those tests run in a different file and
   * would otherwise race to mutate the *same* tenant's `orgs.limits` via
   * `setLimits` below.
   */
  readonly tenantFraud: { readonly id: string; readonly fqdn: string };
  /**
   * S2-06: a tenant dedicated to emergency-calling tests, kept separate from
   * `tenantFraud` for the same reason `tenantFraud` is kept separate from
   * `tenantOutbound` — this suite's own test also calls `setTenantLimits`
   * (to prove the channel-limit bypass), and needs its own emergency route
   * (a trunk-service resource) no other test should see.
   */
  readonly tenantEmergency: { readonly id: string; readonly fqdn: string };
  /** S2-20 (G-50): three extensions, for the "three SIPp participants join" acceptance test issue #39's own "Done when" describes. */
  readonly tenantConference: { readonly id: string; readonly fqdn: string };
  /** S2-20 (G-47): an agent extension (301) and a caller extension (302). */
  readonly tenantQueue: { readonly id: string; readonly fqdn: string };
  /** S2-20 (G-41): one extension (401) with a mailbox to leave/retrieve a message against. */
  readonly tenantVoicemail: { readonly id: string; readonly fqdn: string };
  /** S2-20 (G-43): a caller extension (501) and a bridge-target extension (502) for the auto-attendant's own extension node. */
  readonly tenantFlow: { readonly id: string; readonly fqdn: string };
  /** S2-20 (G-38): a watcher extension (601) and a presentity extension (602). */
  readonly tenantPresence: { readonly id: string; readonly fqdn: string };
  /** `{ number: { password, realm } }`, one entry per seeded extension. */
  readonly extensions: Record<string, { readonly password: string; readonly realm: string }>;
}

const logger = createLogger({ name: 'tests-sip-seed', level: 'info' });

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

/** Creates a reseller/tenant, or finds the existing one with that slug. */
async function findOrCreateOrg(
  orgRepo: ReturnType<typeof createOrgRepo>,
  orgDb: Database<OrgServiceDb>,
  type: 'reseller' | 'tenant',
  parentId: string,
  slug: string,
  name: string,
): Promise<Org> {
  try {
    return await orgRepo.create({}, type, { parentId, slug, name });
  } catch (error) {
    if (!(error instanceof SlugTakenError)) throw error;
    const existing = await orgDb.kysely
      .selectFrom('orgs')
      .selectAll()
      .where('slug', '=', slug)
      .executeTakeFirstOrThrow();
    logger.info({ slug, id: existing.id }, 'org already exists; reusing it');
    return {
      id: existing.id,
      type: existing.type,
      parentId: existing.parent_id,
      resellerId: existing.reseller_id,
      slug: existing.slug,
      name: existing.name,
      status: existing.status,
      timezone: existing.timezone,
      country: existing.country,
      // mysql2 auto-parses a JSON-typed column into an object already —
      // confirmed directly (a `JSON.parse` here throws on a non-string).
      limits: (typeof existing.limits === 'string'
        ? JSON.parse(existing.limits)
        : existing.limits) as Org['limits'],
    };
  }
}

async function tenantFqdn(orgDb: Database<OrgServiceDb>, tenantId: string): Promise<string> {
  const row = await orgDb.kysely
    .selectFrom('tenant_domains')
    .select('fqdn')
    .where('tenant_id', '=', tenantId)
    .where('is_primary', '=', true)
    .executeTakeFirstOrThrow();
  return row.fqdn;
}

export async function seed(): Promise<SeedResult> {
  const orgDb = createDatabase<OrgServiceDb>({
    host: env('ORG_DB_HOST'),
    port: Number(env('ORG_DB_PORT')),
    user: env('ORG_DB_USER'),
    password: env('ORG_DB_PASSWORD'),
    database: env('ORG_DB_NAME'),
    poolSize: 4,
    logger,
  });
  const pbxDb = createDatabase<PbxConfigServiceDb>({
    host: env('PBX_DB_HOST'),
    port: Number(env('PBX_DB_PORT')),
    user: env('PBX_DB_USER'),
    password: env('PBX_DB_PASSWORD'),
    database: env('PBX_DB_NAME'),
    poolSize: 4,
    logger,
  });

  try {
    const orgRepo = createOrgRepo(orgDb, { platformBaseDomain: env('PLATFORM_BASE_DOMAIN') });
    const orgClient = createOrgClient({
      baseUrl: env('ORG_SERVICE_URL'),
      internalServiceToken: env('INTERNAL_SERVICE_TOKEN'),
    });
    const kek = fileKekFromConfig({
      CRYPTO_KEKS: env('CRYPTO_KEKS'),
      CRYPTO_KEK_CURRENT: env('CRYPTO_KEK_CURRENT'),
    });
    const extensionRepo = createExtensionRepo(pbxDb, orgClient.primaryDomain, kek);
    const emergencyLocationRepo = createEmergencyLocationRepo(pbxDb);

    /**
     * S2-06: `extensionRepo.create` now requires a real `emergency_locations`
     * id (G-1 — an extension cannot be provisioned without one). One shared
     * location per tenant is enough for this suite's own purposes (nothing
     * here tests emergency-location content) — found by its own fixed
     * `label` rather than tracked separately, the same "safe to re-run"
     * idempotency `seedExtension` below already needs for the extension
     * itself.
     */
    async function findOrCreateEmergencyLocation(tenantId: string): Promise<string> {
      const ctx = { tenantId };
      const existing = await emergencyLocationRepo.list(ctx);
      const found = existing.find((location) => location.label === 'SIP Test Location');
      if (found !== undefined) return found.id;
      const created = await emergencyLocationRepo.create(ctx, {
        label: 'SIP Test Location',
        addressLine1: '1 Test Way',
        city: 'Testville',
        state: 'CA',
        postalCode: '94000',
        country: 'US',
      });
      return created.id;
    }

    let master: Org;
    try {
      master = await orgRepo.createMaster({ slug: 'master', name: 'Master' });
    } catch (error) {
      if (!(error instanceof MasterAlreadyExistsError)) throw error;
      master = (await orgRepo.findMaster())!;
    }

    const reseller = await findOrCreateOrg(
      orgRepo,
      orgDb,
      'reseller',
      master.id,
      'sip-test',
      'SIP Test Reseller',
    );
    const tenantA = await findOrCreateOrg(
      orgRepo,
      orgDb,
      'tenant',
      reseller.id,
      'acme',
      'Acme (tenant A)',
    );
    const tenantB = await findOrCreateOrg(
      orgRepo,
      orgDb,
      'tenant',
      reseller.id,
      'beta',
      'Beta (tenant B)',
    );
    const tenantSuspended = await findOrCreateOrg(
      orgRepo,
      orgDb,
      'tenant',
      reseller.id,
      'gonesoon',
      'Suspended tenant',
    );
    const tenantOutbound = await findOrCreateOrg(
      orgRepo,
      orgDb,
      'tenant',
      reseller.id,
      'outbound',
      'Outbound failover test tenant',
    );
    const tenantFraud = await findOrCreateOrg(
      orgRepo,
      orgDb,
      'tenant',
      reseller.id,
      'fraud',
      'Toll-fraud controls test tenant',
    );
    const tenantEmergency = await findOrCreateOrg(
      orgRepo,
      orgDb,
      'tenant',
      reseller.id,
      'emergency',
      'Emergency calling test tenant',
    );
    const tenantConference = await findOrCreateOrg(
      orgRepo,
      orgDb,
      'tenant',
      reseller.id,
      'conference',
      'Conference rooms test tenant',
    );
    const tenantQueue = await findOrCreateOrg(
      orgRepo,
      orgDb,
      'tenant',
      reseller.id,
      'queue',
      'Queues test tenant',
    );
    const tenantVoicemail = await findOrCreateOrg(
      orgRepo,
      orgDb,
      'tenant',
      reseller.id,
      'voicemail',
      'Voicemail test tenant',
    );
    const tenantFlow = await findOrCreateOrg(
      orgRepo,
      orgDb,
      'tenant',
      reseller.id,
      'flow',
      'Auto-attendant test tenant',
    );
    const tenantPresence = await findOrCreateOrg(
      orgRepo,
      orgDb,
      'tenant',
      reseller.id,
      'presence',
      'BLF/presence test tenant',
    );

    const extensions: SeedResult['extensions'] = {};

    async function seedExtension(
      tenantId: string,
      number: string,
      displayName: string,
    ): Promise<void> {
      let password: string;
      try {
        const emergencyLocationId = await findOrCreateEmergencyLocation(tenantId);
        const created = await extensionRepo.create(
          { tenantId },
          { number, displayName, emergencyLocationId },
        );
        const revealed = await extensionRepo.reveal({ tenantId }, created.id);
        password = revealed.password;
      } catch (error) {
        if (!(error instanceof ExtensionNumberTakenError)) throw error;
        const existing = await pbxDb.kysely
          .selectFrom('extensions')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .where('number', '=', number)
          .executeTakeFirstOrThrow();
        const revealed = await extensionRepo.reveal({ tenantId }, existing.id);
        password = revealed.password;
        logger.info({ tenantId, number }, 'extension already exists; reusing it');
      }
      const realm = await tenantFqdn(orgDb, tenantId);
      extensions[`${realm}/${number}`] = { password, realm };
    }

    await seedExtension(tenantA.id, '101', 'SIP Test 101');
    await seedExtension(tenantA.id, '102', 'SIP Test 102');
    await seedExtension(tenantB.id, '102', 'SIP Test 102 (tenant B)');
    await seedExtension(tenantSuspended.id, '103', 'SIP Test 103 (suspended)');
    await seedExtension(tenantOutbound.id, '104', 'SIP Test 104 (outbound failover)');
    await seedExtension(tenantFraud.id, '105', 'SIP Test 105 (toll-fraud controls)');
    await seedExtension(tenantEmergency.id, '106', 'SIP Test 106 (emergency calling)');
    await seedExtension(tenantConference.id, '201', 'SIP Test 201 (conference participant 1)');
    await seedExtension(tenantConference.id, '202', 'SIP Test 202 (conference participant 2)');
    await seedExtension(tenantConference.id, '203', 'SIP Test 203 (conference participant 3)');
    await seedExtension(tenantQueue.id, '301', 'SIP Test 301 (queue agent)');
    await seedExtension(tenantQueue.id, '302', 'SIP Test 302 (queue caller)');
    await seedExtension(tenantVoicemail.id, '401', 'SIP Test 401 (voicemail mailbox owner)');
    await seedExtension(tenantVoicemail.id, '402', 'SIP Test 402 (voicemail caller)');
    await seedExtension(tenantFlow.id, '501', 'SIP Test 501 (auto-attendant caller)');
    await seedExtension(tenantFlow.id, '502', 'SIP Test 502 (auto-attendant bridge target)');
    await seedExtension(tenantPresence.id, '601', 'SIP Test 601 (BLF watcher)');
    await seedExtension(tenantPresence.id, '602', 'SIP Test 602 (BLF presentity)');

    // Suspended last, and idempotent: `suspend()` on an already-suspended
    // tenant is a real InvalidOrgStatusTransitionError, not "nothing to do".
    const suspendedNow = await orgDb.kysely
      .selectFrom('orgs')
      .select('status')
      .where('id', '=', tenantSuspended.id)
      .executeTakeFirstOrThrow();
    if (suspendedNow.status !== 'suspended') {
      await orgRepo.suspend({}, tenantSuspended.id);
    }

    const result: SeedResult = {
      resellerId: reseller.id,
      tenantA: { id: tenantA.id, fqdn: await tenantFqdn(orgDb, tenantA.id) },
      tenantB: { id: tenantB.id, fqdn: await tenantFqdn(orgDb, tenantB.id) },
      tenantSuspended: {
        id: tenantSuspended.id,
        fqdn: await tenantFqdn(orgDb, tenantSuspended.id),
      },
      tenantOutbound: {
        id: tenantOutbound.id,
        fqdn: await tenantFqdn(orgDb, tenantOutbound.id),
      },
      tenantEmergency: {
        id: tenantEmergency.id,
        fqdn: await tenantFqdn(orgDb, tenantEmergency.id),
      },
      tenantConference: {
        id: tenantConference.id,
        fqdn: await tenantFqdn(orgDb, tenantConference.id),
      },
      tenantQueue: {
        id: tenantQueue.id,
        fqdn: await tenantFqdn(orgDb, tenantQueue.id),
      },
      tenantVoicemail: {
        id: tenantVoicemail.id,
        fqdn: await tenantFqdn(orgDb, tenantVoicemail.id),
      },
      tenantFlow: {
        id: tenantFlow.id,
        fqdn: await tenantFqdn(orgDb, tenantFlow.id),
      },
      tenantPresence: {
        id: tenantPresence.id,
        fqdn: await tenantFqdn(orgDb, tenantPresence.id),
      },
      tenantFraud: {
        id: tenantFraud.id,
        fqdn: await tenantFqdn(orgDb, tenantFraud.id),
      },
      extensions,
    };
    logger.info(result, 'seed complete');
    return result;
  } finally {
    await orgDb.destroy();
    await pbxDb.destroy();
  }
}

/**
 * S2-05: sets a tenant's `orgs.limits` directly, for a toll-fraud-control
 * test that needs to change it between cases (the seed data above is only
 * ever created once, idempotently — this is the one piece of *mutable*
 * per-test fixture state `seed()` itself has no reason to own). Same
 * direct-repo-bypass rationale as `seed()`'s own top comment.
 */
export async function setLimits(tenantId: string, limits: Record<string, unknown>): Promise<void> {
  const orgDb = createDatabase<OrgServiceDb>({
    host: env('ORG_DB_HOST'),
    port: Number(env('ORG_DB_PORT')),
    user: env('ORG_DB_USER'),
    password: env('ORG_DB_PASSWORD'),
    database: env('ORG_DB_NAME'),
    poolSize: 2,
    logger,
  });
  try {
    const orgRepo = createOrgRepo(orgDb, { platformBaseDomain: env('PLATFORM_BASE_DOMAIN') });
    await orgRepo.update({}, tenantId, { limits });
  } finally {
    await orgDb.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === 'set-limits') {
    const tenantId = process.argv[3];
    const limitsJson = process.argv[4];
    if (tenantId === undefined || limitsJson === undefined) {
      throw new Error('usage: seed.js set-limits <tenantId> <limitsJson>');
    }
    await setLimits(tenantId, JSON.parse(limitsJson) as Record<string, unknown>);
    process.stdout.write('{"ok":true}\n');
  } else {
    const result = await seed();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
