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

    const extensions: SeedResult['extensions'] = {};

    async function seedExtension(
      tenantId: string,
      number: string,
      displayName: string,
    ): Promise<void> {
      let password: string;
      try {
        const created = await extensionRepo.create({ tenantId }, { number, displayName });
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
      extensions,
    };
    logger.info(result, 'seed complete');
    return result;
  } finally {
    await orgDb.destroy();
    await pbxDb.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await seed();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
