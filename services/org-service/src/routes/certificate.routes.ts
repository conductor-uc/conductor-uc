import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server } from '@cuc/http';

import type { Certificate, CertificateRepo } from '../repo/certificate.repo.js';

const OrgParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const FqdnParamsSchema = Type.Object({ fqdn: Type.String({ minLength: 1, maxLength: 253 }) });
const TokenParamsSchema = Type.Object({ token: Type.String({ minLength: 1, maxLength: 128 }) });
const nullableString = Type.Union([Type.String(), Type.Null()]);

const CertificateSchema = Type.Object({
  fqdn: Type.String(),
  purpose: Type.Union([Type.Literal('sip'), Type.Literal('console')]),
  status: Type.Union([Type.Literal('pending'), Type.Literal('active'), Type.Literal('failed')]),
  notBefore: nullableString,
  notAfter: nullableString,
  /** Why the last attempt failed, so an operator knows what to fix (usually DNS). */
  lastError: nullableString,
  attempts: Type.Integer(),
  nextAttemptAt: Type.String(),
});

function toResponse(c: Certificate) {
  return {
    fqdn: c.fqdn,
    purpose: c.purpose,
    status: c.status,
    notBefore: c.notBefore?.toISOString() ?? null,
    notAfter: c.notAfter?.toISOString() ?? null,
    lastError: c.lastError,
    attempts: c.attempts,
    nextAttemptAt: c.nextAttemptAt.toISOString(),
  };
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match?.[1];
}

/**
 * What the console shows about the TLS certificates the platform keeps (G-105):
 * what state each is in, and why one is failing. The service-to-service routes
 * are registered separately, so they are not in the console's API description.
 */
export function registerCertificateRoutes(app: Server, certs: CertificateRepo): void {
  app.get(
    '/v1/resellers/:id/certificates',
    {
      config: { permission: 'domain.manage', dataClass: 'config' },
      schema: {
        params: OrgParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(CertificateSchema) }) },
      },
    },
    async (request) => ({
      rows: (await certs.list({ resellerId: request.params.id })).map(toResponse),
    }),
  );

  app.get(
    '/v1/platform/certificates',
    {
      config: { permission: 'domain.manage', dataClass: 'config' },
      schema: { response: { 200: Type.Object({ rows: Type.Array(CertificateSchema) }) } },
    },
    async (request) => {
      // The platform's own hostnames belong to the master alone.
      if (request.context.orgType !== 'master') {
        throw ProblemError.forbidden(
          "Only the platform operator can see the platform's certificates.",
        );
      }
      return { rows: (await certs.list({ resellerId: null })).map(toResponse) };
    },
  );
}

/**
 * Service to service (bearer token): the SIP proxy a tenant connects to, a
 * certificate with its key for the consumers that serve it, and the answer to an
 * ACME HTTP challenge for the edge to serve on port 80.
 */
export function registerCertificateInternalRoutes(
  app: Server,
  certs: CertificateRepo,
  internalServiceToken: string,
): void {
  function requireInternal(header: string | undefined): void {
    const presented = bearerToken(header);
    if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
      throw ProblemError.unauthorized('A valid internal service token is required.');
    }
  }

  app.get(
    '/internal/v1/tenants/:id/sip-proxy',
    {
      config: { public: true },
      schema: {
        params: OrgParamsSchema,
        response: {
          200: Type.Object({
            host: Type.String(),
            status: Type.Union([
              Type.Literal('pending'),
              Type.Literal('active'),
              Type.Literal('failed'),
            ]),
          }),
        },
      },
    },
    async (request) => {
      requireInternal(request.headers.authorization);
      const proxy = await certs.sipProxyFor(request.params.id);
      if (proxy === undefined) throw ProblemError.notFound('That tenant has no domain yet.');
      return proxy;
    },
  );

  app.get(
    '/internal/v1/certificates/:fqdn',
    {
      config: { public: true },
      schema: {
        params: FqdnParamsSchema,
        response: {
          200: Type.Object({
            fqdn: Type.String(),
            purpose: Type.Union([Type.Literal('sip'), Type.Literal('console')]),
            resellerId: nullableString,
            version: Type.Integer(),
            notAfter: Type.String(),
            certificate: Type.String(),
            privateKey: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      requireInternal(request.headers.authorization);
      const material = await certs.getMaterial(request.params.fqdn);
      if (material === undefined)
        throw ProblemError.notFound('No certificate is held for that name.');
      // The response carries a private key: nothing on the way may keep a copy.
      void reply.header('cache-control', 'no-store');
      return {
        fqdn: material.fqdn,
        purpose: material.purpose,
        resellerId: material.resellerId,
        version: material.version,
        notAfter: material.notAfter.toISOString(),
        certificate: material.certificatePem,
        privateKey: material.privateKeyPem,
      };
    },
  );

  app.get(
    '/internal/v1/acme/challenges/:token',
    {
      config: { public: true },
      schema: {
        params: TokenParamsSchema,
        response: { 200: Type.Object({ keyAuthorization: Type.String() }) },
      },
    },
    async (request) => {
      requireInternal(request.headers.authorization);
      const answer = await certs.getChallenge(request.params.token);
      if (answer === undefined) throw ProblemError.notFound('No such challenge.');
      return { keyAuthorization: answer };
    },
  );
}
