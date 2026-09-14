import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { createAuditRepo, type AuditRepo } from '../src/repo/audit.repo.js';
import { registerAuditRoutes } from '../src/routes/audit.routes.js';
import { migrations } from '../migrations/index.js';
import type { IdentityServiceDb } from '../src/schema.js';

const skipReason = await databaseOrSkipReason();

describe.skipIf(skipReason !== undefined)('audit-service HTTP routes', () => {
  let db: Database<IdentityServiceDb>;
  let repo: AuditRepo;
  let app: Server;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const logger = silentLogger();
    const handle = await startTestDatabase();
    db = createDatabase<IdentityServiceDb>({
      host: handle.host,
      port: handle.port,
      user: handle.user,
      password: handle.password,
      database: handle.database,
      logger,
    });
    await migrateToLatest({ db: db.kysely, migrations, logger });
    repo = createAuditRepo(db);

    app = await createServer({ serviceName: 'identity-service', logger });
    registerAuditRoutes(app, repo);
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

  afterEach(async () => {
    await db.kysely.deleteFrom('audit_events').execute();
  });

  it('returns the events visible to the named org', async () => {
    await db.kysely.transaction().execute(async (trx) => {
      await repo.insert(trx, randomUUID(), new Date(), {
        actorType: 'user',
        actorId: 'master-user-1',
        actorOrgId: 'master-org',
        targetOrgId: 'tenant-1',
        action: 'cdr.read',
        resource: 'cdr:abc123',
        dataClass: 'private',
      });
    });

    const response = await app.inject({ method: 'GET', url: '/v1/orgs/tenant-1/audit-events' });

    expect(response.statusCode).toBe(200);
    const body: { rows: { action: string; at: string }[] } = response.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ action: 'cdr.read' });
    // `at` serializes as an ISO string, not a bare Date object.
    expect(() => new Date(body.rows[0]!.at).toISOString()).not.toThrow();
  });

  it('returns an empty list for an org with no visible events', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/orgs/no-such-org/audit-events' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rows: [] });
  });

  it('respects a limit query parameter', async () => {
    await db.kysely.transaction().execute(async (trx) => {
      for (let i = 0; i < 3; i++) {
        await repo.insert(trx, randomUUID(), new Date(), {
          actorType: 'user',
          actorId: 'u1',
          actorOrgId: 'org1',
          action: 'x',
          resource: `r${String(i)}`,
          dataClass: 'config',
        });
      }
    });

    const response = await app.inject({ method: 'GET', url: '/v1/orgs/org1/audit-events?limit=2' });

    const body: { rows: unknown[] } = response.json();
    expect(body.rows).toHaveLength(2);
  });

  it('declares permission and dataClass (CLAUDE.md rule 3)', () => {
    const route = app.registeredRoutes.find((r) => r.url === '/v1/orgs/:orgId/audit-events');
    expect(route?.permission).toBe('audit.read');
    expect(route?.dataClass).not.toBeNull();
  });
});
