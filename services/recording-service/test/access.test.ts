import { describe, expect, it } from 'vitest';

import { AccessUnavailableError, createHttpAccessClient } from '../src/access.js';

const ACCESS = {
  roles: [{ id: 'tenant_supervisor', permissions: ['monitor.listen'] }],
  grants: [
    {
      principalType: 'user',
      principalId: 'u1',
      permission: 'recording.listen',
      scope: { type: 'queue', id: 'Q1' },
    },
  ],
};

function client(fetchImpl: typeof fetch, now: () => number = () => 0, ttlMs = 5_000) {
  return createHttpAccessClient({
    baseUrl: 'http://identity:8080/',
    internalServiceToken: 'tok',
    ttlMs,
    fetchImpl,
    now,
  });
}

describe('http access client', () => {
  it('asks identity-service with the internal token and reuses the answer for the ttl only', async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    let clock = 0;
    const access = client(
      (input, init) => {
        seen.push({
          url: typeof input === 'string' ? input : '',
          auth: (init?.headers as Record<string, string> | undefined)?.['authorization'],
        });
        return Promise.resolve(new Response(JSON.stringify(ACCESS)));
      },
      () => clock,
    );

    expect(await access.resolve({ orgId: 'org 1', actorId: 'u1' })).toEqual(ACCESS);
    clock = 4_999;
    await access.resolve({ orgId: 'org 1', actorId: 'u1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      url: 'http://identity:8080/internal/v1/orgs/org%201/users/u1/access',
      auth: 'Bearer tok',
    });

    clock = 5_001; // a revoked grant stops working once the cache entry lapses
    await access.resolve({ orgId: 'org 1', actorId: 'u1' });
    expect(seen).toHaveLength(2);
  });

  it('treats a user identity-service has never heard of as having no access', async () => {
    const access = client(() => Promise.resolve(new Response('{}', { status: 404 })));
    expect(await access.resolve({ orgId: 'o', actorId: 'ghost' })).toEqual({
      roles: [],
      grants: [],
    });
  });

  it('fails closed when identity-service is down or errors, and does not cache the failure', async () => {
    let up = false;
    const access = client(() =>
      up
        ? Promise.resolve(new Response(JSON.stringify(ACCESS)))
        : Promise.reject(new TypeError('connect ECONNREFUSED')),
    );
    await expect(access.resolve({ orgId: 'o', actorId: 'u1' })).rejects.toBeInstanceOf(
      AccessUnavailableError,
    );
    const erroring = client(() => Promise.resolve(new Response('{}', { status: 500 })));
    await expect(erroring.resolve({ orgId: 'o', actorId: 'u1' })).rejects.toBeInstanceOf(
      AccessUnavailableError,
    );
    up = true;
    await expect(access.resolve({ orgId: 'o', actorId: 'u1' })).resolves.toEqual(ACCESS);
  });
});
