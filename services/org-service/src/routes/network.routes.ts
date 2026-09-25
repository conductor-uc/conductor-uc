import { publishAuditEvent } from '@cuc/audit';
import type { Bus } from '@cuc/events';
import { clientIpOf, ProblemError, Type, type Server } from '@cuc/http';

import { InvalidPublicAddressError, recordTypeFor } from '../domain/dns.js';
import type { CertificateRepo } from '../repo/certificate.repo.js';
import type { PlatformNetworkRepo } from '../repo/platform-network.repo.js';

const nullableString = Type.Union([Type.String(), Type.Null()]);

const NetworkSchema = Type.Object({ publicAddress: nullableString });

const DnsRecordsSchema = Type.Object({
  /** Where the names are to point; null until the operator has said. */
  publicAddress: nullableString,
  rows: Type.Array(
    Type.Object({
      name: Type.String(),
      type: Type.Union([Type.Literal('A'), Type.Literal('AAAA'), Type.Literal('CNAME')]),
      /** What the record holds, or null until the platform's address is known. */
      value: nullableString,
      purpose: Type.Union([Type.Literal('sip'), Type.Literal('console')]),
    }),
  ),
});

/**
 * The platform's public address, and the DNS records a reseller publishes so its
 * names reach it (G-105). Everything shares one address, so the records are one
 * line per name the platform keeps a certificate for.
 */
export function registerNetworkRoutes(
  app: Server,
  network: PlatformNetworkRepo,
  certs: CertificateRepo,
  bus: Bus,
): void {
  app.get(
    '/v1/platform/network-settings',
    {
      config: { permission: 'domain.manage', dataClass: 'config' },
      schema: { response: { 200: NetworkSchema } },
    },
    async (request) => {
      requireMaster(request.context.orgType);
      return { publicAddress: await network.publicAddress() };
    },
  );

  app.put(
    '/v1/platform/network-settings',
    {
      config: { permission: 'domain.manage', dataClass: 'config' },
      schema: {
        body: Type.Object({
          publicAddress: Type.Union([Type.String({ maxLength: 255 }), Type.Null()]),
        }),
        response: { 200: NetworkSchema },
      },
    },
    async (request) => {
      requireMaster(request.context.orgType);
      const { actorId, actorType, orgId } = request.context;
      if (actorId === undefined || actorType === undefined || orgId === undefined) {
        throw ProblemError.unauthorized(
          'An identified actor is required to change these settings.',
        );
      }
      let publicAddress: string | null;
      try {
        publicAddress = await network.savePublicAddress(request.body.publicAddress);
      } catch (error) {
        if (error instanceof InvalidPublicAddressError) {
          throw ProblemError.badRequest(error.message, { code: 'invalid_public_address' });
        }
        throw error;
      }
      await publishAuditEvent(bus, {
        actorType,
        actorId,
        actorOrgId: orgId,
        action: 'platform.network_settings.updated',
        resource: publicAddress ?? 'cleared',
        dataClass: 'config',
        ip: clientIpOf(request),
        requestId: request.context.requestId,
      });
      return { publicAddress };
    },
  );

  app.get(
    '/v1/resellers/:id/dns-records',
    {
      config: { permission: 'domain.manage', dataClass: 'config' },
      schema: {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        response: { 200: DnsRecordsSchema },
      },
    },
    async (request) => {
      const publicAddress = await network.publicAddress();
      const type = publicAddress === null ? 'A' : recordTypeFor(publicAddress);
      const held = await certs.list({ resellerId: request.params.id });
      return {
        publicAddress,
        rows: held.map((c) => ({
          name: c.fqdn,
          type,
          value: publicAddress,
          purpose: c.purpose,
        })),
      };
    },
  );

  function requireMaster(orgType: string | undefined): void {
    if (orgType !== 'master') {
      throw ProblemError.forbidden(
        "Only the platform operator can see or change the platform's address.",
      );
    }
  }
}
