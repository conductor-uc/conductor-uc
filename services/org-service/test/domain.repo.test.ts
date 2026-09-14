import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import type { DnsResolver } from '../src/dns-resolver.js';
import { InvalidFqdnError } from '../src/domain/domain.js';
import {
  BaseDomainNotFoundError,
  DomainNotVerifiedError,
  DomainTakenError,
  createDomainRepo,
  type DomainRepo,
} from '../src/repo/domain.repo.js';
import { createOrgRepo, type OrgRepo } from '../src/repo/org.repo.js';
import { migrations } from '../migrations/index.js';
import type { OrgServiceDb } from '../src/schema.js';

const skipReason = await databaseOrSkipReason();

/** Returns whatever TXT records `records` says exist at each hostname, and throws (NXDOMAIN-like) otherwise. */
function fakeResolver(records: Record<string, string[][]>): DnsResolver {
  return {
    resolveTxt: (hostname) => {
      const found = records[hostname];
      if (found === undefined) return Promise.reject(new Error('queryTxt ENOTFOUND'));
      return Promise.resolve(found);
    },
  };
}

describe.skipIf(skipReason !== undefined)('domain repo', () => {
  let db: Database<OrgServiceDb>;
  let domains: DomainRepo;
  let orgs: OrgRepo;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const logger = silentLogger();
    const handle = await startTestDatabase();
    db = createDatabase<OrgServiceDb>({
      host: handle.host,
      port: handle.port,
      user: handle.user,
      password: handle.password,
      database: handle.database,
      logger,
    });
    await migrateToLatest({ db: db.kysely, migrations, logger });
    domains = createDomainRepo(db);
    orgs = createOrgRepo(db, { platformBaseDomain: 'platform.test' });
    stop = async () => {
      await db.destroy();
      await handle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  beforeEach(async () => {
    await db.kysely.deleteFrom('tenant_domains').execute();
    await db.kysely.deleteFrom('reseller_base_domains').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'tenant').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'reseller').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'master').execute();
    await db.kysely.deleteFrom('outbox').execute();
  });

  async function makeReseller() {
    const master = await orgs.createMaster({ slug: 'master', name: 'Master' });
    return orgs.create({}, 'reseller', { parentId: master.id, slug: 'acme', name: 'Acme' });
  }

  describe('registerBaseDomain', () => {
    it('registers a pending domain with a verification token', async () => {
      const reseller = await makeReseller();

      const domain = await domains.registerBaseDomain(reseller.id, 'voice.reseller-brand.com');

      expect(domain).toMatchObject({
        resellerId: reseller.id,
        fqdn: 'voice.reseller-brand.com',
        status: 'pending',
        verificationRecordName: '_domain-verification.voice.reseller-brand.com',
        verifiedAt: null,
      });
      expect(domain.verificationToken.length).toBeGreaterThan(0);
    });

    it('rejects an invalid fqdn', async () => {
      const reseller = await makeReseller();

      await expect(domains.registerBaseDomain(reseller.id, 'not a domain')).rejects.toThrow(
        InvalidFqdnError,
      );
    });

    it('rejects a duplicate base domain', async () => {
      const reseller = await makeReseller();
      await domains.registerBaseDomain(reseller.id, 'voice.reseller-brand.com');

      await expect(
        domains.registerBaseDomain(reseller.id, 'voice.reseller-brand.com'),
      ).rejects.toThrow(DomainTakenError);
    });

    it('rejects a base domain that collides with an existing tenant domain — globally unique (02 §3)', async () => {
      const reseller = await makeReseller();
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'widgets',
        name: 'Widgets',
      });
      const tenantDomain = await domains.findPrimaryTenantDomain(tenant.id);

      await expect(domains.registerBaseDomain(reseller.id, tenantDomain!.fqdn)).rejects.toThrow(
        DomainTakenError,
      );
    });
  });

  describe('verifyBaseDomain', () => {
    it('activates the domain when the TXT record matches', async () => {
      const reseller = await makeReseller();
      const pending = await domains.registerBaseDomain(reseller.id, 'voice.reseller-brand.com');
      const resolver = fakeResolver({
        '_domain-verification.voice.reseller-brand.com': [[pending.verificationToken]],
      });

      const verified = await domains.verifyBaseDomain({}, reseller.id, pending.id, resolver);

      expect(verified.status).toBe('active');
      expect(verified.verifiedAt).not.toBeNull();
    });

    it('rejects when the TXT record is missing', async () => {
      const reseller = await makeReseller();
      const pending = await domains.registerBaseDomain(reseller.id, 'voice.reseller-brand.com');
      const resolver = fakeResolver({});

      await expect(domains.verifyBaseDomain({}, reseller.id, pending.id, resolver)).rejects.toThrow(
        DomainNotVerifiedError,
      );
    });

    it('rejects when the TXT record has the wrong value', async () => {
      const reseller = await makeReseller();
      const pending = await domains.registerBaseDomain(reseller.id, 'voice.reseller-brand.com');
      const resolver = fakeResolver({
        '_domain-verification.voice.reseller-brand.com': [['wrong-token']],
      });

      await expect(domains.verifyBaseDomain({}, reseller.id, pending.id, resolver)).rejects.toThrow(
        DomainNotVerifiedError,
      );
    });

    it('reports a DNS resolution failure the same way as a missing record', async () => {
      const reseller = await makeReseller();
      const pending = await domains.registerBaseDomain(reseller.id, 'voice.reseller-brand.com');
      const throwingResolver: DnsResolver = {
        resolveTxt: () => Promise.reject(new Error('queryTxt ETIMEOUT')),
      };

      await expect(
        domains.verifyBaseDomain({}, reseller.id, pending.id, throwingResolver),
      ).rejects.toThrow(DomainNotVerifiedError);
    });

    it('is idempotent once active — re-verifying does not re-check DNS', async () => {
      const reseller = await makeReseller();
      const pending = await domains.registerBaseDomain(reseller.id, 'voice.reseller-brand.com');
      const goodResolver = fakeResolver({
        '_domain-verification.voice.reseller-brand.com': [[pending.verificationToken]],
      });
      await domains.verifyBaseDomain({}, reseller.id, pending.id, goodResolver);

      const throwingResolver: DnsResolver = {
        resolveTxt: () => Promise.reject(new Error('should not be called')),
      };
      const result = await domains.verifyBaseDomain({}, reseller.id, pending.id, throwingResolver);

      expect(result.status).toBe('active');
    });

    it('rejects an unknown domain id', async () => {
      const reseller = await makeReseller();

      await expect(
        domains.verifyBaseDomain({}, reseller.id, 'no-such-domain', fakeResolver({})),
      ).rejects.toThrow(BaseDomainNotFoundError);
    });

    it('rejects a domain id that belongs to a different reseller', async () => {
      const master = await orgs.createMaster({ slug: 'master', name: 'Master' });
      const resellerA = await orgs.create({}, 'reseller', {
        parentId: master.id,
        slug: 'reseller-a',
        name: 'A',
      });
      const resellerB = await orgs.create({}, 'reseller', {
        parentId: master.id,
        slug: 'reseller-b',
        name: 'B',
      });
      const domain = await domains.registerBaseDomain(resellerA.id, 'voice.a-brand.com');

      await expect(
        domains.verifyBaseDomain({}, resellerB.id, domain.id, fakeResolver({})),
      ).rejects.toThrow(BaseDomainNotFoundError);
    });

    it('publishes org.domain.added for a reseller base domain', async () => {
      const reseller = await makeReseller();
      const pending = await domains.registerBaseDomain(reseller.id, 'voice.reseller-brand.com');
      const resolver = fakeResolver({
        '_domain-verification.voice.reseller-brand.com': [[pending.verificationToken]],
      });

      await domains.verifyBaseDomain({}, reseller.id, pending.id, resolver);

      const rows = await db.kysely
        .selectFrom('outbox')
        .selectAll()
        .where('type', '=', 'org.domain.added')
        .execute();
      expect(rows).toHaveLength(1);
      const raw = rows[0]!.payload;
      const data = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
        scope: string;
        ownerId: string;
      };
      expect(data).toMatchObject({ scope: 'reseller_base', ownerId: reseller.id });
    });
  });

  describe('listBaseDomains / findBaseDomain', () => {
    it("lists only the given reseller's base domains", async () => {
      const master = await orgs.createMaster({ slug: 'master', name: 'Master' });
      const resellerA = await orgs.create({}, 'reseller', {
        parentId: master.id,
        slug: 'reseller-a',
        name: 'A',
      });
      const resellerB = await orgs.create({}, 'reseller', {
        parentId: master.id,
        slug: 'reseller-b',
        name: 'B',
      });
      const domainA = await domains.registerBaseDomain(resellerA.id, 'voice.a-brand.com');
      await domains.registerBaseDomain(resellerB.id, 'voice.b-brand.com');

      const listed = await domains.listBaseDomains(resellerA.id);

      expect(listed.map((d) => d.id)).toEqual([domainA.id]);
    });
  });
});
