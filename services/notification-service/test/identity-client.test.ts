import { describe, expect, it } from 'vitest';

import { createIdentityClient, IdentityClientError } from '../src/identity-client.js';

function clientAnswering(status: number, body: unknown, seen: Request[] = []) {
  return createIdentityClient({
    baseUrl: 'http://identity.test/',
    internalServiceToken: 'svc-token',
    fetchImpl: (input, init) => {
      seen.push(new Request(input, init));
      return Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });
}

describe('identity client (G-55)', () => {
  it('POSTs to the link route of that org and id, with the service token', async () => {
    const seen: Request[] = [];
    const client = clientAnswering(
      200,
      { token: 'tok', expiresAt: '2026-09-25T12:00:00.000Z' },
      seen,
    );

    expect(await client.issuePasswordResetLink('org 1', 'reset/1')).toEqual({
      status: 'issued',
      token: 'tok',
      expiresAt: new Date('2026-09-25T12:00:00.000Z'),
    });
    await client.issueInvitationLink('org-1', 'inv-1');

    expect(seen.map((r) => [r.method, r.url, r.headers.get('authorization')])).toEqual([
      [
        'POST',
        'http://identity.test/internal/v1/orgs/org%201/password-resets/reset%2F1/link',
        'Bearer svc-token',
      ],
      [
        'POST',
        'http://identity.test/internal/v1/orgs/org-1/invitations/inv-1/link',
        'Bearer svc-token',
      ],
    ]);
  });

  it('reports a 404 or 409 as a refusal, with its code', async () => {
    expect(await clientAnswering(409, { code: 'link_used' }).issueInvitationLink('o', 'i')).toEqual(
      { status: 'refused', httpStatus: 409, code: 'link_used' },
    );
    expect(await clientAnswering(404, undefined).issuePasswordResetLink('o', 'r')).toEqual({
      status: 'refused',
      httpStatus: 404,
    });
  });

  it('throws, to be retried, on anything else', async () => {
    await expect(clientAnswering(503, {}).issuePasswordResetLink('o', 'r')).rejects.toThrow(
      IdentityClientError,
    );
    await expect(clientAnswering(401, {}).issuePasswordResetLink('o', 'r')).rejects.toThrow(
      /\(401\)/,
    );
    await expect(
      clientAnswering(200, { expiresAt: 'x' }).issuePasswordResetLink('o', 'r'),
    ).rejects.toThrow(/without a link/);
    const unreachable = createIdentityClient({
      baseUrl: 'http://identity.test',
      internalServiceToken: 'svc-token',
      fetchImpl: () => Promise.reject(new TypeError('fetch failed: http://identity.test/...')),
    });
    await expect(unreachable.issueInvitationLink('o', 'i')).rejects.toThrow(
      'Could not reach identity-service (TypeError).',
    );
  });
});
