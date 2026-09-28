import { describe, expect, it, vi } from 'vitest';

import { createApiKeyVerifier, InvalidApiKeyError } from '../src/auth/api-key-verifier.js';

const KEY = `key_0123456789ab_${'a'.repeat(32)}`;
const IDENTITY = { keyId: 'k1', orgId: 't1', orgType: 'tenant', resellerId: null };

function verifier(fetchImpl: typeof fetch, now = () => 0) {
  return createApiKeyVerifier({
    baseUrl: 'http://identity/',
    internalServiceToken: 'tok',
    fetchImpl,
    now,
    ttlMs: 1000,
  });
}

describe('createApiKeyVerifier (S1-08)', () => {
  it('asks identity-service with the service token, and reuses a good answer for the ttl', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json(IDENTITY)));
    let clock = 0;
    const keys = verifier(fetchImpl, () => clock);
    expect(await keys.verify(KEY)).toEqual(IDENTITY);
    await keys.verify(KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('http://identity/internal/v1/api-keys/verify', {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY }),
    });
    clock = 1001;
    await keys.verify(KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never remembers a refused key', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ code: 'api_key_invalid' }, { status: 401 })),
    );
    const keys = verifier(fetchImpl);
    await expect(keys.verify(KEY)).rejects.toBeInstanceOf(InvalidApiKeyError);
    await expect(keys.verify(KEY)).rejects.toBeInstanceOf(InvalidApiKeyError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails closed when identity-service is unreachable or errors', async () => {
    const down = verifier(() => Promise.reject(new Error('down')));
    await expect(down.verify(KEY)).rejects.toMatchObject({
      status: 503,
      code: 'api_key_check_unavailable',
    });
    const broken = verifier(() => Promise.resolve(new Response('', { status: 500 })));
    await expect(broken.verify(KEY)).rejects.toMatchObject({ status: 503 });
  });
});
