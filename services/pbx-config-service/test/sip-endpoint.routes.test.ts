import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';
import { silentLogger } from '@cuc/testing';

import {
  parseSipTransports,
  registerSipEndpointRoutes,
} from '../src/routes/sip-endpoint.routes.js';

const SECRET = 'test-internal-header-secret';

describe('parseSipTransports', () => {
  it('reads a comma list, trimmed, lower-cased and without repeats', () => {
    expect(parseSipTransports(' UDP, tcp ,udp')).toEqual(['udp', 'tcp']);
  });

  it('refuses an unknown transport and an empty list', () => {
    expect(() => parseSipTransports('udp,quic')).toThrow(/quic/);
    expect(() => parseSipTransports(' , ')).toThrow(/at least one/);
  });
});

describe('pbx-config-service SIP endpoint route', () => {
  let app: Server;
  const domains: Record<string, string> = { 't-1': 'acme.voice.platform.test' };

  beforeAll(async () => {
    app = await createServer({
      serviceName: 'pbx-config-service',
      logger: silentLogger(),
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerSipEndpointRoutes(app, (tenantId) => Promise.resolve(domains[tenantId]), {
      port: 5060,
      tlsPort: 5061,
      transports: ['udp', 'tcp'],
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  function headers(tenantId: string) {
    return signInternalHeaders(SECRET, {
      actorId: 'user-1',
      actorType: 'user',
      orgId: tenantId,
      orgType: 'tenant',
      tenantId,
    });
  }

  it("returns the tenant's domain as server and realm, with the edge's port and transports", async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t-1/sip-endpoint',
      headers: headers('t-1'),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      server: 'acme.voice.platform.test',
      port: 5060,
      tlsPort: null,
      transports: ['udp', 'tcp'],
      realm: 'acme.voice.platform.test',
    });
  });

  it('reports the TLS port, which is not the plain one, when TLS is offered', async () => {
    const tls = await createServer({
      serviceName: 'pbx-config-service',
      logger: silentLogger(),
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerSipEndpointRoutes(tls, (tenantId) => Promise.resolve(domains[tenantId]), {
      port: 5060,
      tlsPort: 5061,
      transports: ['tls', 'udp'],
    });
    await tls.ready();
    try {
      const response = await tls.inject({
        method: 'GET',
        url: '/v1/tenants/t-1/sip-endpoint',
        headers: headers('t-1'),
      });
      expect(response.json()).toMatchObject({
        port: 5060,
        tlsPort: 5061,
        transports: ['tls', 'udp'],
      });
    } finally {
      await tls.close();
    }
  });

  it('says so, rather than inventing a server, when the tenant has no domain yet', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t-2/sip-endpoint',
      headers: headers('t-2'),
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('no domain');
  });
});
