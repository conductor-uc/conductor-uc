import { describe, expect, it } from 'vitest';

import { buildRouteTable, isPublicPath, resolveRoute } from '../src/routing/route-table.js';

const SERVICES = { identity: 'http://identity:8080', org: 'http://org:8080' };

describe('buildRouteTable', () => {
  it('resolves each prefix to its configured service base URL', () => {
    const table = buildRouteTable(['/v1/auth=identity', '/v1/tenants=org'], SERVICES);

    expect(resolveRoute(table, '/v1/auth/login')).toEqual({
      prefix: '/v1/auth',
      target: 'http://identity:8080',
    });
    expect(resolveRoute(table, '/v1/tenants/t1')).toEqual({
      prefix: '/v1/tenants',
      target: 'http://org:8080',
    });
  });

  it('matches the longest configured prefix first', () => {
    const table = buildRouteTable(['/v1/orgs=identity', '/v1/orgs/special=org'], SERVICES);

    expect(resolveRoute(table, '/v1/orgs/special/x')?.target).toBe('http://org:8080');
    expect(resolveRoute(table, '/v1/orgs/other')?.target).toBe('http://identity:8080');
  });

  it('matches the bare prefix itself, not only its children', () => {
    const table = buildRouteTable(['/v1/public=org'], SERVICES);

    expect(resolveRoute(table, '/v1/public')?.target).toBe('http://org:8080');
  });

  it('does not match a prefix that merely starts with the same characters', () => {
    const table = buildRouteTable(['/v1/org=identity'], SERVICES);

    // '/v1/orgs' is not under '/v1/org' — it just happens to share a prefix
    // string, which is exactly the bug a naive `startsWith` check would have.
    expect(resolveRoute(table, '/v1/orgs/x')).toBeUndefined();
  });

  it('returns undefined for a path no entry covers', () => {
    const table = buildRouteTable(['/v1/auth=identity'], SERVICES);

    expect(resolveRoute(table, '/v1/unmapped')).toBeUndefined();
  });

  it('rejects a malformed entry', () => {
    expect(() => buildRouteTable(['not-an-entry'], SERVICES)).toThrow(/prefix=service/);
  });

  it('rejects an entry naming an unknown service', () => {
    expect(() => buildRouteTable(['/v1/x=nowhere'], SERVICES)).toThrow(/unknown service/);
  });
});

describe('isPublicPath', () => {
  const prefixes = ['/v1/auth', '/v1/public'];

  it('matches a path under a public prefix', () => {
    expect(isPublicPath(prefixes, '/v1/auth/login')).toBe(true);
    expect(isPublicPath(prefixes, '/v1/public/brand')).toBe(true);
  });

  it('does not match a path outside every public prefix', () => {
    expect(isPublicPath(prefixes, '/v1/tenants/t1')).toBe(false);
  });

  it('does not match a path that merely shares a prefix string', () => {
    expect(isPublicPath(prefixes, '/v1/authorization')).toBe(false);
  });
});
