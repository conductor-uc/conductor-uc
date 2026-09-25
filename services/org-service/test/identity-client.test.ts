import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AdminUserCreationError,
  AdminUserEmailTakenError,
  createIdentityClient,
  OrgHasUsersError,
} from '../src/identity-client.js';

const TOKEN = 'test-internal-service-token';

/**
 * A real HTTP server standing in for identity-service's
 * `POST /internal/v1/orgs/:orgId/admin-user`, so this proves the client's
 * wire behavior (method, path, headers, body, status handling) rather than
 * mocking `fetch` and only proving the mock was called correctly.
 */
async function fakeIdentityService(
  handler: (req: IncomingMessage, body: unknown, res: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      handler(req, raw === '' ? undefined : (JSON.parse(raw) as unknown), res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe('createIdentityClient', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('POSTs the right path, bearer token, and body', async () => {
    let seenPath: string | undefined;
    let seenAuth: string | undefined;
    let seenBody: unknown;
    const fake = await fakeIdentityService((req, body, res) => {
      seenPath = req.url;
      seenAuth = req.headers.authorization;
      seenBody = body;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'u1', orgId: 'org1', email: 'admin@example.com' }));
    });
    close = fake.close;

    const client = createIdentityClient({ baseUrl: fake.baseUrl, internalServiceToken: TOKEN });
    const result = await client.createAdminUser({
      orgId: 'org1',
      orgType: 'tenant',
      resellerId: 'reseller1',
      email: 'admin@example.com',
      displayName: 'Admin',
      password: 'correct horse battery staple',
    });

    expect(seenPath).toBe('/internal/v1/orgs/org1/admin-user');
    expect(seenAuth).toBe(`Bearer ${TOKEN}`);
    expect(seenBody).toEqual({
      orgType: 'tenant',
      resellerId: 'reseller1',
      email: 'admin@example.com',
      displayName: 'Admin',
      password: 'correct horse battery staple',
    });
    expect(result).toEqual({ id: 'u1', email: 'admin@example.com' });
  });

  it('omits resellerId from the body when null (a reseller admin)', async () => {
    let seenBody: unknown;
    const fake = await fakeIdentityService((_req, body, res) => {
      seenBody = body;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'u1', email: 'admin@example.com' }));
    });
    close = fake.close;

    const client = createIdentityClient({ baseUrl: fake.baseUrl, internalServiceToken: TOKEN });
    await client.createAdminUser({
      orgId: 'org1',
      orgType: 'reseller',
      resellerId: null,
      email: 'admin@example.com',
      displayName: 'Admin',
      password: 'correct horse battery staple',
    });

    expect(seenBody).not.toHaveProperty('resellerId');
  });

  it('throws AdminUserEmailTakenError on a 409', async () => {
    const fake = await fakeIdentityService((_req, _body, res) => {
      res.writeHead(409, { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ title: 'Conflict', detail: 'email taken' }));
    });
    close = fake.close;

    const client = createIdentityClient({ baseUrl: fake.baseUrl, internalServiceToken: TOKEN });

    await expect(
      client.createAdminUser({
        orgId: 'org1',
        orgType: 'tenant',
        resellerId: 'r1',
        email: 'dup@example.com',
        displayName: 'Admin',
        password: 'correct horse battery staple',
      }),
    ).rejects.toThrow(AdminUserEmailTakenError);
  });

  it('sends firstUserOnly and throws OrgHasUsersError on a 409 org_has_users', async () => {
    let seenBody: unknown;
    const fake = await fakeIdentityService((_req, body, res) => {
      seenBody = body;
      res.writeHead(409, { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ title: 'Conflict', code: 'org_has_users', detail: 'has users' }));
    });
    close = fake.close;

    const client = createIdentityClient({ baseUrl: fake.baseUrl, internalServiceToken: TOKEN });

    await expect(
      client.createAdminUser({
        orgId: 'm1',
        orgType: 'master',
        resellerId: null,
        email: 'admin@example.com',
        displayName: 'Admin',
        password: 'correct horse battery staple',
        firstUserOnly: true,
      }),
    ).rejects.toThrow(OrgHasUsersError);
    expect(seenBody).toMatchObject({ orgType: 'master', firstUserOnly: true });
    expect(seenBody).not.toHaveProperty('resellerId');
  });

  it('throws AdminUserCreationError on any other non-2xx status', async () => {
    const fake = await fakeIdentityService((_req, _body, res) => {
      res.writeHead(500, { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ title: 'Internal error' }));
    });
    close = fake.close;

    const client = createIdentityClient({ baseUrl: fake.baseUrl, internalServiceToken: TOKEN });

    await expect(
      client.createAdminUser({
        orgId: 'org1',
        orgType: 'tenant',
        resellerId: 'r1',
        email: 'a@example.com',
        displayName: 'Admin',
        password: 'correct horse battery staple',
      }),
    ).rejects.toThrow(AdminUserCreationError);
  });

  it('throws AdminUserCreationError when the server is unreachable', async () => {
    const client = createIdentityClient({
      baseUrl: 'http://127.0.0.1:1',
      internalServiceToken: TOKEN,
    });

    await expect(
      client.createAdminUser({
        orgId: 'org1',
        orgType: 'tenant',
        resellerId: 'r1',
        email: 'a@example.com',
        displayName: 'Admin',
        password: 'correct horse battery staple',
      }),
    ).rejects.toThrow(AdminUserCreationError);
  });

  it('tolerates a trailing slash on baseUrl', async () => {
    let seenPath: string | undefined;
    const fake = await fakeIdentityService((req, _body, res) => {
      seenPath = req.url;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'u1', email: 'admin@example.com' }));
    });
    close = fake.close;

    const client = createIdentityClient({
      baseUrl: `${fake.baseUrl}/`,
      internalServiceToken: TOKEN,
    });
    await client.createAdminUser({
      orgId: 'org1',
      orgType: 'reseller',
      resellerId: null,
      email: 'a@example.com',
      displayName: 'Admin',
      password: 'correct horse battery staple',
    });

    expect(seenPath).toBe('/internal/v1/orgs/org1/admin-user');
  });
});
