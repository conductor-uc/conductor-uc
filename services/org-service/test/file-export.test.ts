import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { connectBus, type Bus } from '@cuc/events';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';
import { createStorage, type Storage } from '@cuc/storage';
import {
  databaseOrSkipReason,
  natsOrSkipReason,
  s3OrSkipReason,
  silentLogger,
  startTestDatabase,
  startTestNats,
  startTestS3,
} from '@cuc/testing';

import { migrations } from '../migrations/index.js';
import { createFileExportConsumer } from '../src/file-export.consumer.js';
import { createFileExportRepo, type FileExportRepo } from '../src/repo/file-export.repo.js';
import { registerFileExportRoutes } from '../src/routes/file-export.routes.js';
import type { OrgServiceDb } from '../src/schema.js';

const skipReason =
  (await databaseOrSkipReason()) ?? (await natsOrSkipReason()) ?? (await s3OrSkipReason());
const SECRET = 'test-internal-header-secret';

describe.skipIf(skipReason !== undefined)("a tenant's files export (S1-16, G-11 (2))", () => {
  let db: Database<OrgServiceDb>;
  let bus: Bus;
  let storage: Storage;
  let exports: FileExportRepo;
  let app: Server;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const logger = silentLogger();
    const dbHandle = await startTestDatabase();
    const natsHandle = await startTestNats();
    const s3 = await startTestS3();
    db = createDatabase<OrgServiceDb>({ ...dbHandle, logger });
    await migrateToLatest({ db: db.kysely, migrations, logger });
    bus = await connectBus({ servers: [natsHandle.server], logger, name: 'org-export-test' });
    await bus.ensureStreams();
    storage = createStorage({
      mode: 'prefix-per-tenant',
      bucketPrefix: `cuc-export-${randomUUID().slice(0, 6)}`,
      endpoint: s3.endpoint,
      region: s3.region,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      forcePathStyle: s3.forcePathStyle,
      logger,
    });
    exports = createFileExportRepo(db);
    app = await createServer({
      serviceName: 'org-service',
      logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerFileExportRoutes(app, { exports, storage });
    await app.ready();
    stop = async () => {
      await app.close();
      await bus.close();
      await natsHandle.stop();
      await s3.stop();
      await db.destroy();
      await dbHandle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  const as = (orgType: 'tenant' | 'reseller', orgId: string, tenantId: string) =>
    signInternalHeaders(SECRET, {
      actorId: 'user-1',
      actorType: 'user',
      orgId,
      orgType,
      ...(orgType === 'tenant' ? { tenantId } : {}),
    });

  it('zips every recording and voicemail file, and hands out a link to it', async () => {
    const tenantId = randomUUID();
    const files = storage.forTenant(tenantId);
    await files.provisionBucket();
    await files.putObject('recordings/2026/09/28/a.wav', Buffer.from('RIFF-recording'));
    await files.putObject('voicemail/mb-1/m-1.wav', Buffer.from('RIFF-message'));
    await files.putObject('voicemail/mb-1/greeting.wav', Buffer.from('RIFF-greeting'));
    // Not part of this export (prompts, other exports).
    await files.putObject('media/prompt.wav', Buffer.from('RIFF-prompt'));

    const asked = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/file-exports`,
      headers: as('tenant', tenantId, tenantId),
    });
    expect(asked.statusCode, asked.body).toBe(202);
    const { id } = asked.json<{ id: string }>();

    const consumer = createFileExportConsumer(db, bus, silentLogger(), storage, exports, {
      pullTimeoutMs: 1000,
    });
    await consumer.ensure();
    await bus.publish({
      id: randomUUID(),
      type: 'org.file_export.requested',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      orgContext: { tenantId },
      data: { exportId: id, tenantId },
    });
    for (let i = 0; i < 10 && (await exports.findById(tenantId, id))?.status !== 'ready'; i++) {
      await consumer.runOnce();
    }

    const done = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/file-exports/${id}`,
      headers: as('tenant', tenantId, tenantId),
    });
    const body = done.json<{ status: string; fileCount: number; downloadUrl: string }>();
    expect(body).toMatchObject({ status: 'ready', fileCount: 3 });
    const zip = Buffer.from(await (await fetch(body.downloadUrl)).arrayBuffer());
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    const names = zip.toString('latin1');
    expect(names).toContain('recordings/2026/09/28/a.wav');
    expect(names).toContain('voicemail/mb-1/greeting.wav');
    expect(names).not.toContain('media/prompt.wav');

    // Asking and every link handed out are audited.
    const audit = JSON.stringify(await db.kysely.selectFrom('outbox').selectAll().execute());
    expect(audit).toContain('data.export.requested');
    expect(audit).toContain('data.export.downloaded');
  }, 60_000);

  it('never to a reseller, even for its own tenant (H1)', async () => {
    const tenantId = randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/file-exports`,
      headers: as('reseller', randomUUID(), tenantId),
    });
    expect(response.statusCode).toBe(403);
  });
});
