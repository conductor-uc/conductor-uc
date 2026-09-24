import { ProblemError, Type, type Server } from '@cuc/http';

import { activeSipProxy, type SipProxyLookup, type TenantDomainLookup } from '../org-client.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });

const TRANSPORTS = ['udp', 'tcp', 'tls'] as const;
export type SipTransport = (typeof TRANSPORTS)[number];

/** Where a phone reaches the edge, as the platform is deployed. Set by the operator, not per tenant. */
export interface SipEdgeConfig {
  /** The port the edge accepts SIP on over UDP and TCP. */
  readonly port: number;
  /** The port it accepts SIP on over TLS. Only used when `tls` is offered. */
  readonly tlsPort: number;
  /** Transports the edge accepts, most preferred first. */
  readonly transports: readonly SipTransport[];
}

/** Parses `SIP_PUBLIC_TRANSPORTS` (e.g. `udp,tcp`). Throws on an unknown or empty list, so a typo stops the service at startup. */
export function parseSipTransports(raw: string): SipTransport[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '');
  const seen = new Set<SipTransport>();
  for (const part of parts) {
    if (!(TRANSPORTS as readonly string[]).includes(part)) {
      throw new Error(`SIP_PUBLIC_TRANSPORTS: "${part}" is not one of ${TRANSPORTS.join(', ')}.`);
    }
    seen.add(part as SipTransport);
  }
  if (seen.size === 0) throw new Error('SIP_PUBLIC_TRANSPORTS must name at least one transport.');
  return [...seen];
}

const SipEndpointSchema = Type.Object({
  /** What to enter as the phone's server / registrar. The tenant's own domain, so it is also the realm. */
  server: Type.String(),
  port: Type.Integer(),
  /** Set when TLS is offered: the port for that transport, which is not the plain one. */
  tlsPort: Type.Union([Type.Integer(), Type.Null()]),
  transports: Type.Array(Type.String()),
  realm: Type.String(),
  /**
   * Set when the tenant's phones should connect to a proxy of their own and keep
   * `server` as the domain they log in to (an outbound proxy). Null until the
   * proxy has a certificate, when phones connect to the server directly.
   */
  outboundProxy: Type.Union([Type.String(), Type.Null()]),
});

/**
 * `GET /v1/tenants/:tenantId/sip-endpoint` — what a person needs, besides an
 * extension's own username and password, to register a phone or softphone:
 * the server, port, and transports, and the realm.
 *
 * The server is the tenant's primary domain (org-service), the same value the
 * extension credentials are hashed against, so the domain a phone is given and
 * the realm it authenticates in cannot disagree. Port and transports are the
 * edge's own and come from configuration. Nothing here is secret.
 */
export function registerSipEndpointRoutes(
  app: Server,
  primaryDomain: TenantDomainLookup,
  edge: SipEdgeConfig,
  sipProxy?: SipProxyLookup,
): void {
  app.get(
    '/v1/tenants/:tenantId/sip-endpoint',
    {
      config: { permission: 'extension.manage', dataClass: 'config' },
      schema: { params: TenantParamsSchema, response: { 200: SipEndpointSchema } },
    },
    async (request) => {
      const domain = await primaryDomain(request.params.tenantId);
      if (domain === undefined) {
        throw ProblemError.conflict(
          'This tenant has no domain yet, so phones have nothing to register to.',
        );
      }
      return {
        server: domain,
        port: edge.port,
        tlsPort: edge.transports.includes('tls') ? edge.tlsPort : null,
        transports: [...edge.transports],
        realm: domain,
        outboundProxy: (await activeSipProxy(sipProxy, request.params.tenantId)) ?? null,
      };
    },
  );
}
