import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import { createAuditRepo, type AuditRepo } from '../src/repo/audit.repo.js';
import { migrations } from '../migrations/index.js';
import type { IdentityServiceDb } from '../src/schema.js';

const skipReason = await databaseOrSkipReason();

describe.skipIf(skipReason !== undefined)('audit repo', () => {
  let db: Database<IdentityServiceDb>;
  let repo: AuditRepo;
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
    stop = async () => {
      await db.destroy();
      await handle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  beforeEach(async () => {
    await db.kysely.deleteFrom('audit_events').execute();
  });

  describe('insert', () => {
    it('stores a full row', async () => {
      const id = randomUUID();
      const at = new Date('2026-05-01T12:00:00.000Z');

      await db.kysely.transaction().execute(async (trx) => {
        await repo.insert(trx, id, at, {
          actorType: 'user',
          actorId: 'master-user-1',
          actorOrgId: 'master-org',
          targetOrgId: 'tenant-1',
          action: 'cdr.read',
          resource: 'cdr:abc123',
          dataClass: 'private',
          reason: 'support ticket #42',
          ip: '203.0.113.5',
          requestId: 'req-1',
        });
      });

      const [event] = await repo.listForOrg('tenant-1');
      expect(event).toMatchObject({
        id,
        actorType: 'user',
        actorId: 'master-user-1',
        actorOrgId: 'master-org',
        targetOrgId: 'tenant-1',
        action: 'cdr.read',
        resource: 'cdr:abc123',
        dataClass: 'private',
        reason: 'support ticket #42',
        ip: '203.0.113.5',
        requestId: 'req-1',
      });
    });

    it('stores a row with no target org (a cross-tenant query)', async () => {
      const id = randomUUID();

      await db.kysely.transaction().execute(async (trx) => {
        await repo.insert(trx, id, new Date(), {
          actorType: 'user',
          actorId: 'reseller-user-1',
          actorOrgId: 'reseller-1',
          action: 'unscoped_query',
          resource: 'reseller dashboard',
          dataClass: 'private',
        });
      });

      const [event] = await repo.listForOrg('reseller-1');
      expect(event?.targetOrgId).toBeNull();
    });
  });

  describe('listForOrg — visibility (07 §4)', () => {
    async function seed(): Promise<void> {
      await db.kysely.transaction().execute(async (trx) => {
        // The tenant's own admin updates its own extension: actor and target are the same org.
        await repo.insert(trx, randomUUID(), new Date('2026-05-01T10:00:00Z'), {
          actorType: 'user',
          actorId: 'tenant-admin-1',
          actorOrgId: 'tenant-1',
          targetOrgId: 'tenant-1',
          action: 'extension.updated',
          resource: 'extension:100',
          dataClass: 'config',
        });
        // Master reads the tenant's private CDR: 07 §3.1's "audited, not denied" case.
        await repo.insert(trx, randomUUID(), new Date('2026-05-01T11:00:00Z'), {
          actorType: 'user',
          actorId: 'master-user-1',
          actorOrgId: 'master-org',
          targetOrgId: 'tenant-1',
          action: 'cdr.read',
          resource: 'cdr:abc123',
          dataClass: 'private',
        });
        // A completely unrelated tenant's own action: neither field names tenant-1.
        await repo.insert(trx, randomUUID(), new Date('2026-05-01T12:00:00Z'), {
          actorType: 'user',
          actorId: 'tenant2-admin-1',
          actorOrgId: 'tenant-2',
          targetOrgId: 'tenant-2',
          action: 'extension.updated',
          resource: 'extension:200',
          dataClass: 'config',
        });
        // Master-internal action unrelated to tenant-1 (creating a reseller).
        await repo.insert(trx, randomUUID(), new Date('2026-05-01T13:00:00Z'), {
          actorType: 'user',
          actorId: 'master-user-1',
          actorOrgId: 'master-org',
          targetOrgId: 'reseller-9',
          action: 'reseller.created',
          resource: 'org:reseller-9',
          dataClass: 'config',
        });
      });
    }

    it("shows the tenant its own actions and master's audited access to its private data — nothing else", async () => {
      await seed();

      const events = await repo.listForOrg('tenant-1');

      expect(events.map((e) => e.action).sort()).toEqual(['cdr.read', 'extension.updated']);
      expect(events.every((e) => e.actorOrgId === 'tenant-1' || e.targetOrgId === 'tenant-1')).toBe(
        true,
      );
    });

    it("does not show the tenant a different tenant's own actions or master-internal actions unrelated to it", async () => {
      await seed();

      const events = await repo.listForOrg('tenant-1');

      expect(events.some((e) => e.resource === 'extension:200')).toBe(false);
      expect(events.some((e) => e.resource === 'org:reseller-9')).toBe(false);
    });

    it('shows master its own actions, across every org they touched', async () => {
      await seed();

      const events = await repo.listForOrg('master-org');

      expect(events.map((e) => e.action).sort()).toEqual(['cdr.read', 'reseller.created']);
    });

    it('orders by time, most recent first', async () => {
      await seed();

      const events = await repo.listForOrg('master-org');

      expect(events[0]?.action).toBe('reseller.created');
      expect(events[1]?.action).toBe('cdr.read');
    });

    it('respects the limit', async () => {
      await seed();

      const events = await repo.listForOrg('master-org', 1);

      expect(events).toHaveLength(1);
    });
  });
});
