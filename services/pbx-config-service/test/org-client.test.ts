import { describe, expect, it } from 'vitest';

import { activeSipProxy, createOrgClient, OrgClientError } from '../src/org-client.js';

function client(respond: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const auth: (string | undefined)[] = [];
  const fetchImpl = ((input: string, init?: RequestInit) => {
    urls.push(input);
    auth.push((init?.headers as Record<string, string> | undefined)?.authorization);
    return Promise.resolve(respond(input));
  }) as unknown as typeof fetch;
  return {
    urls,
    auth,
    org: createOrgClient({ baseUrl: 'http://org/', internalServiceToken: 'tok', fetchImpl }),
  };
}

describe('sipProxy', () => {
  it("asks org-service for the tenant's proxy with the internal token", async () => {
    const { org, urls, auth } = client(() =>
      Response.json({ host: 'sip.r.test', status: 'active' }),
    );
    expect(await org.sipProxy('t/1')).toEqual({ host: 'sip.r.test', status: 'active' });
    expect(urls).toEqual(['http://org/internal/v1/tenants/t%2F1/sip-proxy']);
    expect(auth).toEqual(['Bearer tok']);
  });

  it('is undefined for a tenant with no domain, and an error for anything else', async () => {
    expect(
      await client(() => new Response('{}', { status: 404 })).org.sipProxy('t'),
    ).toBeUndefined();
    await expect(
      client(() => new Response('{"detail":"nope"}', { status: 500 })).org.sipProxy('t'),
    ).rejects.toThrow(OrgClientError);
  });
});

describe('activeSipProxy', () => {
  it('is the host only while the proxy has a certificate', async () => {
    expect(await activeSipProxy(undefined, 't')).toBeUndefined();
    expect(
      await activeSipProxy(() => Promise.resolve({ host: 'h', status: 'pending' }), 't'),
    ).toBeUndefined();
    expect(
      await activeSipProxy(() => Promise.resolve({ host: 'h', status: 'failed' }), 't'),
    ).toBeUndefined();
    expect(await activeSipProxy(() => Promise.resolve({ host: 'h', status: 'active' }), 't')).toBe(
      'h',
    );
  });
});
