import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@cuc/api-contracts';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import type { Bus } from '@cuc/events';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import type { TermsLookup } from '../src/acme-terms.js';
import { createAcmeSettingsRepo } from '../src/repo/acme-settings.repo.js';
import { registerAcmeSettingsRoutes } from '../src/routes/acme-settings.routes.js';
import type { OrgServiceDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';

const skipReason = await databaseOrSkipReason();
const SECRET = 'test-internal-header-secret';
const TERMS = 'https://letsencrypt.org/documents/LE-SA-v9.9.pdf';

function fakeBus(): Bus & { published: EventEnvelope[] } {
  const published: EventEnvelope[] = [];
  return {
    published,
    js: undefined as never,
    jsm: undefined as never,
    connection: undefined as never,
    publish: (envelope: EventEnvelope) => {
      published.push(envelope);
      return Promise.resolve({ sequence: published.length, duplicate: false });
    },
    ensureStreams: () => Promise.resolve(),
    ping: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
}

describe.skipIf(skipReason !== undefined)('acme settings routes', () => {
  let db: Database<OrgServiceDb>;
  let app: Server;
  let bus: ReturnType<typeof fakeBus>;
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
    bus = fakeBus();
    const terms: TermsLookup = { termsUrl: () => Promise.resolve(TERMS) };
    app = await createServer({
      serviceName: 'org-service',
      logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerAcmeSettingsRoutes(app, createAcmeSettingsRepo(db), terms, bus);
    await app.ready();
    stop = async () => {
      await app.close();
      await db.destroy();
      await handle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  beforeEach(async () => {
    await db.kysely.deleteFrom('acme_settings').execute();
    bus.published.length = 0;
  });

  const master = () =>
    signInternalHeaders(SECRET, {
      actorId: 'user-1',
      actorType: 'user',
      orgId: 'master-org',
      orgType: 'master',
    });
  const reseller = () =>
    signInternalHeaders(SECRET, {
      actorId: 'user-2',
      actorType: 'user',
      orgId: 'reseller-org',
      orgType: 'reseller',
    });

  it('shows the operator the current state, with the agreement to read', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/platform/acme-settings',
      headers: master(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      contactEmail: null,
      directory: 'production',
      termsUrl: TERMS,
      termsAgreed: false,
      termsAgreedAt: null,
      ready: false,
    });
  });

  it("is the platform operator's alone", async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const response = await app.inject({
        method,
        url: '/v1/platform/acme-settings',
        headers: reseller(),
        ...(method === 'PUT'
          ? {
              payload: {
                contactEmail: 'a@example.com',
                directory: 'production',
                agreeToTerms: true,
              },
            }
          : {}),
      });
      expect(response.statusCode, method).toBe(403);
    }
    expect(await db.kysely.selectFrom('acme_settings').selectAll().execute()).toEqual([]);
  });

  it('saves the address and the agreement, becomes ready, and audits who did it', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/platform/acme-settings',
      headers: master(),
      payload: { contactEmail: ' Certs@Example.com ', directory: 'production', agreeToTerms: true },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      contactEmail: 'certs@example.com',
      termsAgreed: true,
      termsUrl: TERMS,
      ready: true,
    });
    const saved = await db.kysely.selectFrom('acme_settings').selectAll().executeTakeFirstOrThrow();
    expect(saved.terms_agreed_by).toBe('user-1');

    expect(bus.published).toHaveLength(1);
    expect(bus.published[0]).toMatchObject({
      type: 'audit.event.recorded',
      actor: { type: 'user', id: 'user-1', orgId: 'master-org' },
      data: { action: 'platform.acme_settings.updated', dataClass: 'config' },
    });
  });

  it('refuses an invalid address with 400, changes nothing, and audits nothing', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/platform/acme-settings',
      headers: master(),
      payload: { contactEmail: 'not an email', directory: 'production', agreeToTerms: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('invalid_contact_email');
    expect(await db.kysely.selectFrom('acme_settings').selectAll().execute()).toEqual([]);
    expect(bus.published).toHaveLength(0);
  });

  it('lets the operator choose staging, or withdraw the agreement, and reports it', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/platform/acme-settings',
      headers: master(),
      payload: { contactEmail: 'a@example.com', directory: 'production', agreeToTerms: true },
    });
    const staging = await app.inject({
      method: 'PUT',
      url: '/v1/platform/acme-settings',
      headers: master(),
      payload: { contactEmail: 'a@example.com', directory: 'staging', agreeToTerms: false },
    });
    expect(staging.json()).toMatchObject({
      directory: 'staging',
      termsAgreed: false,
      ready: false,
    });
  });

  it('needs an identified actor to change anything', async () => {
    const anonymous = await app.inject({
      method: 'PUT',
      url: '/v1/platform/acme-settings',
      payload: { contactEmail: 'a@example.com', directory: 'production', agreeToTerms: true },
    });
    expect([401, 403]).toContain(anonymous.statusCode);
    expect(await db.kysely.selectFrom('acme_settings').selectAll().execute()).toEqual([]);
  });
});
