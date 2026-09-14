import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import { InvalidFqdnError } from '../domain/domain.js';
import type { DnsResolver } from '../dns-resolver.js';
import {
  BaseDomainNotFoundError,
  DomainNotVerifiedError,
  DomainTakenError,
  type BaseDomain,
  type DomainRepo,
} from '../repo/domain.repo.js';

const OrgIdParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const BaseDomainParamsSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  domainId: Type.String({ minLength: 1 }),
});

const RegisterBaseDomainBodySchema = Type.Object({ fqdn: Type.String({ minLength: 1 }) });

const BaseDomainSchema = Type.Object({
  id: Type.String(),
  resellerId: Type.String(),
  fqdn: Type.String(),
  status: Type.Union([Type.Literal('pending'), Type.Literal('active')]),
  verificationRecordName: Type.String(),
  /** Present only while `status` is `pending` — nothing to prove once verified. */
  verificationToken: Type.Optional(Type.String()),
  verifiedAt: Type.Union([Type.String(), Type.Null()]),
});

type BaseDomainResponse = Static<typeof BaseDomainSchema>;

function toResponse(domain: BaseDomain): BaseDomainResponse {
  return {
    id: domain.id,
    resellerId: domain.resellerId,
    fqdn: domain.fqdn,
    status: domain.status,
    verificationRecordName: domain.verificationRecordName,
    ...(domain.status === 'pending' ? { verificationToken: domain.verificationToken } : {}),
    verifiedAt: domain.verifiedAt === null ? null : domain.verifiedAt.toISOString(),
  };
}

/**
 * Registers reseller base-domain routes (S1-03; 06's org-service section):
 * register a candidate, then verify it by publishing a TXT record.
 *
 * A tenant's own primary domain has no routes here — it is assigned
 * atomically at tenant creation (`org.repo.ts`'s `create()`), not managed
 * through a separate endpoint. `GET /v1/tenants/:id/domain` below only reads
 * it back.
 */
export function registerDomainRoutes(app: Server, repo: DomainRepo, resolver: DnsResolver): void {
  app.post(
    '/v1/resellers/:id/base-domains',
    {
      config: { permission: 'domain.manage', dataClass: 'config' },
      schema: {
        params: OrgIdParamsSchema,
        body: RegisterBaseDomainBodySchema,
        response: { 201: BaseDomainSchema },
      },
    },
    async (request, reply) => {
      try {
        const domain = await repo.registerBaseDomain(request.params.id, request.body.fqdn);
        return reply.status(201).send(toResponse(domain));
      } catch (error) {
        if (error instanceof InvalidFqdnError) throw ProblemError.badRequest(error.message);
        if (error instanceof DomainTakenError) {
          throw ProblemError.conflict(error.message, { code: 'domain_taken' });
        }
        throw error;
      }
    },
  );

  app.get(
    '/v1/resellers/:id/base-domains',
    {
      config: { permission: 'domain.manage', dataClass: 'config' },
      schema: {
        params: OrgIdParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(BaseDomainSchema) }) },
      },
    },
    async (request) => ({ rows: (await repo.listBaseDomains(request.params.id)).map(toResponse) }),
  );

  app.get(
    '/v1/resellers/:id/base-domains/:domainId',
    {
      config: { permission: 'domain.manage', dataClass: 'config' },
      schema: { params: BaseDomainParamsSchema, response: { 200: BaseDomainSchema } },
    },
    async (request) => {
      const domain = await repo.findBaseDomain(request.params.domainId);
      if (domain === undefined || domain.resellerId !== request.params.id) {
        throw ProblemError.notFound('No base domain with that id.');
      }
      return toResponse(domain);
    },
  );

  app.post(
    '/v1/resellers/:id/base-domains/:domainId/verify',
    {
      config: { permission: 'domain.manage', dataClass: 'config' },
      schema: { params: BaseDomainParamsSchema, response: { 200: BaseDomainSchema } },
    },
    async (request) => {
      try {
        const domain = await repo.verifyBaseDomain(
          request.context,
          request.params.id,
          request.params.domainId,
          resolver,
        );
        return toResponse(domain);
      } catch (error) {
        if (error instanceof BaseDomainNotFoundError) throw ProblemError.notFound(error.message);
        if (error instanceof DomainNotVerifiedError) {
          throw ProblemError.conflict(error.message, { code: 'domain_not_verified' });
        }
        throw error;
      }
    },
  );

  app.get(
    '/v1/tenants/:id/domain',
    {
      config: { permission: 'tenant.manage', dataClass: 'config' },
      schema: {
        params: OrgIdParamsSchema,
        response: {
          200: Type.Object({ id: Type.String(), fqdn: Type.String(), isPrimary: Type.Boolean() }),
        },
      },
    },
    async (request) => {
      const domain = await repo.findPrimaryTenantDomain(request.params.id);
      if (domain === undefined) throw ProblemError.notFound('No primary domain for that tenant.');
      return domain;
    },
  );
}
