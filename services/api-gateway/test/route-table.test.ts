import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadServiceConfig } from '../src/config.js';
import { buildRouteTable, isPublicPath, resolveRoute } from '../src/routing/route-table.js';

const SERVICES = {
  identity: 'http://identity:8080',
  org: 'http://org:8080',
  pbx: 'http://pbx:8080',
  callflow: 'http://callflow:8080',
  voicemail: 'http://voicemail:8080',
  cdr: 'http://cdr:8080',
  trunk: 'http://trunk:8080',
  recording: 'http://recording:8080',
};

describe('buildRouteTable', () => {
  it('resolves each prefix to its configured service base URL', () => {
    const table = buildRouteTable(['/v1/auth=identity', '/v1/tenants=org'], SERVICES);

    expect(resolveRoute(table, '/v1/auth/login')).toMatchObject({
      prefix: '/v1/auth',
      target: 'http://identity:8080',
    });
    expect(resolveRoute(table, '/v1/tenants/t1')).toMatchObject({
      prefix: '/v1/tenants',
      target: 'http://org:8080',
    });
  });

  it('matches the longest configured prefix first', () => {
    const table = buildRouteTable(['/v1/orgs=identity', '/v1/orgs/special=org'], SERVICES);

    expect(resolveRoute(table, '/v1/orgs/special/x')?.target).toBe('http://org:8080');
    expect(resolveRoute(table, '/v1/orgs/other')?.target).toBe('http://identity:8080');
  });

  it('lets * stand for one segment, and prefers the more specific pattern', () => {
    const table = buildRouteTable(['/v1/tenants=org', '/v1/tenants/*/flows=callflow'], SERVICES);

    expect(resolveRoute(table, '/v1/tenants/t1/flows')?.target).toBe(SERVICES.callflow);
    expect(resolveRoute(table, '/v1/tenants/t1/flows/f1/publish?x=1')?.target).toBe(
      SERVICES.callflow,
    );
    // Not a flows path: falls back to the tenant tree.
    expect(resolveRoute(table, '/v1/tenants/t1')?.target).toBe(SERVICES.org);
    expect(resolveRoute(table, '/v1/tenants/t1/suspend')?.target).toBe(SERVICES.org);
    // `*` is one segment, not zero: this is the tenant id position.
    expect(resolveRoute(table, '/v1/tenants/flows')?.target).toBe(SERVICES.org);
  });

  it('orders by literal segments before length, whatever order they are listed in', () => {
    const forward = buildRouteTable(['/v1/a/*/b=pbx', '/v1/a=org'], SERVICES);
    const backward = buildRouteTable(['/v1/a=org', '/v1/a/*/b=pbx'], SERVICES);

    expect(resolveRoute(forward, '/v1/a/x/b')?.target).toBe(SERVICES.pbx);
    expect(resolveRoute(backward, '/v1/a/x/b')?.target).toBe(SERVICES.pbx);
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

describe('the default routing table', () => {
  const config = loadServiceConfig({
    SERVICE_NAME: 'api-gateway',
    INTERNAL_HEADER_SIGNING_SECRET: 'a-signing-secret-of-enough-length',
    IDENTITY_SERVICE_URL: SERVICES.identity,
    ORG_SERVICE_URL: SERVICES.org,
    PBX_CONFIG_SERVICE_URL: SERVICES.pbx,
    CALLFLOW_SERVICE_URL: SERVICES.callflow,
    VOICEMAIL_SERVICE_URL: SERVICES.voicemail,
    CDR_SERVICE_URL: SERVICES.cdr,
    TRUNK_SERVICE_URL: SERVICES.trunk,
    RECORDING_SERVICE_URL: SERVICES.recording,
    REDIS_URL: 'redis://localhost:6379',
  });
  const table = buildRouteTable(config.ROUTE_TABLE, SERVICES);

  it.each([
    ['/v1/auth/login', SERVICES.identity],
    ['/v1/orgs/o1/invitations', SERVICES.identity],
    ['/v1/public/brand', SERVICES.org],
    ['/v1/resellers/r1/brand', SERVICES.org],
    ['/v1/tenants/t1', SERVICES.org],
    ['/v1/tenants/t1/suspend', SERVICES.org],
    ['/v1/tenants/t1/domain', SERVICES.org],
    ['/v1/session/brand', SERVICES.org],
    ['/v1/platform/acme-settings', SERVICES.org],
    ['/v1/platform/certificates', SERVICES.org],
    ['/v1/platform/network-settings', SERVICES.org],
    ['/v1/resellers/r1/certificates', SERVICES.org],
    ['/v1/tenants/t1/extensions/e1/reveal', SERVICES.pbx],
    ['/v1/tenants/t1/sip-endpoint', SERVICES.pbx],
    ['/v1/tenants/t1/devices', SERVICES.pbx],
    ['/v1/tenants/t1/devices/d1/provisioning-credentials', SERVICES.pbx],
    ['/v1/public/provision/yealink/001565aabbcc.cfg', SERVICES.pbx],
    ['/v1/public/brand', SERVICES.org],
    ['/v1/tenants/t1/extensions/e1/reset-password', SERVICES.pbx],
    ['/v1/tenants/t1/schedules', SERVICES.pbx],
    ['/v1/tenants/t1/flows/f1/versions/2', SERVICES.callflow],
    ['/v1/tenants/t1/voicemail/mailboxes/m1/messages', SERVICES.voicemail],
    ['/v1/tenants/t1/cdrs', SERVICES.cdr],
    ['/v1/tenants/t1/trunks/tr1/ips', SERVICES.trunk],
    ['/v1/tenants/t1/recordings', SERVICES.recording],
    ['/v1/tenants/t1/recordings/r1/play-url', SERVICES.recording],
    ['/v1/tenants/t1/recording-policies/p1', SERVICES.recording],
    ['/v1/tenants/t1/recording-settings', SERVICES.recording],
  ])('%s goes to its service', (path, target) => {
    expect(resolveRoute(table, path)?.target).toBe(target);
  });
});

/**
 * Every route a service registers, read from its source, so a route added to a
 * service without a gateway pattern fails here instead of answering 404 (or
 * worse, reaching the wrong service) at the edge.
 */
const OWNERS: Readonly<Record<string, keyof typeof SERVICES>> = {
  'identity-service': 'identity',
  'org-service': 'org',
  'pbx-config-service': 'pbx',
  'callflow-service': 'callflow',
  'voicemail-service': 'voicemail',
  'cdr-service': 'cdr',
  'trunk-service': 'trunk',
  'recording-service': 'recording',
};

const SERVICES_DIR = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

function declaredPaths(service: string): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(join(SERVICES_DIR, service, 'src', 'routes'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/'(\/v1\/[^']*)'/g)) {
      // Not `/internal/...`, not a table entry like '/v1/auth=identity'.
      if (match[1] !== undefined && !match[1].includes('=')) found.add(match[1]);
    }
  }
  return [...found];
}

const filled = (path: string) => path.replace(/:[A-Za-z]+/g, 'p1');

describe('every service route resolves through the default table', () => {
  const table = buildRouteTable(
    loadServiceConfig({
      SERVICE_NAME: 'api-gateway',
      INTERNAL_HEADER_SIGNING_SECRET: 'a-signing-secret-of-enough-length',
      IDENTITY_SERVICE_URL: SERVICES.identity,
      ORG_SERVICE_URL: SERVICES.org,
      PBX_CONFIG_SERVICE_URL: SERVICES.pbx,
      CALLFLOW_SERVICE_URL: SERVICES.callflow,
      VOICEMAIL_SERVICE_URL: SERVICES.voicemail,
      CDR_SERVICE_URL: SERVICES.cdr,
      TRUNK_SERVICE_URL: SERVICES.trunk,
      RECORDING_SERVICE_URL: SERVICES.recording,
      REDIS_URL: 'redis://localhost:6379',
    }).ROUTE_TABLE,
    SERVICES,
  );

  for (const [service, key] of Object.entries(OWNERS)) {
    it(`${service}: each route goes to ${key}, decided by one most specific pattern`, () => {
      const paths = declaredPaths(service);
      expect(paths.length).toBeGreaterThan(0);
      for (const declared of paths) {
        const path = filled(declared);
        const matches = table.filter((e) => resolveRoute([e], path) !== undefined);
        expect(matches[0]?.target, declared).toBe(SERVICES[key]);
        // No other service is equally specific about this path.
        const first = matches[0];
        const rival = matches.find(
          (e) =>
            e !== first &&
            e.target !== first?.target &&
            e.segments.filter((s) => s !== '*').length ===
              first?.segments.filter((s) => s !== '*').length &&
            e.segments.length === first?.segments.length,
        );
        expect(rival, `${declared} is claimed equally by two services`).toBeUndefined();
      }
    });
  }

  it('every path in the console OpenAPI dump is a declared service route', () => {
    const dump = JSON.parse(
      readFileSync(join(SERVICES_DIR, '../apps/console/api/openapi.json'), 'utf8'),
    ) as { paths: Record<string, unknown> };
    const declared = new Set(
      Object.keys(OWNERS).flatMap((service) => declaredPaths(service).map(filled)),
    );
    const braces = (path: string) => path.replace(/\{[^}]+\}/g, 'p1');
    // Answered by the gateway itself, so no service declares it.
    const gatewayOwn = new Set(['/v1/platform/health']);
    for (const path of Object.keys(dump.paths)) {
      if (gatewayOwn.has(path)) continue;
      expect(declared.has(braces(path)), path).toBe(true);
      expect(resolveRoute(table, braces(path)), path).toBeDefined();
    }
  });
});
