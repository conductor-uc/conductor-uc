import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import type { DomainRepo } from '../repo/domain.repo.js';
import type { OrgRepo } from '../repo/org.repo.js';

const TenantParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const DomainResponseSchema = Type.Object({ fqdn: Type.String() });
const ResellerResponseSchema = Type.Object({ resellerId: Type.String() });
const CountryResponseSchema = Type.Object({ country: Type.String() });
const LimitsResponseSchema = Type.Object({ limits: Type.Record(Type.String(), Type.Unknown()) });

/**
 * `GET /internal/v1/tenants/:id/domain` (06). What pbx-config-service calls
 * to learn a tenant's current SIP realm when generating credentials (S1-09;
 * 02 §3: "Changing a tenant's primary domain invalidates stored SIP digest
 * HA1 values, which include the realm").
 *
 * Not the public `GET /v1/tenants/:id/domain` route: that one is reached
 * through api-gateway and carries a `permission`/`dataClass` contract no
 * service-to-service caller can honestly claim either side of yet (same
 * reasoning as identity-service's `/internal/v1/orgs/:orgId/admin-user`,
 * S1-05) — gated by the shared `INTERNAL_SERVICE_TOKEN` instead, checked
 * inside the handler.
 */
export function registerInternalRoutes(
  app: Server,
  domains: DomainRepo,
  internalServiceToken: string,
  orgs: OrgRepo,
): void {
  app.get(
    '/internal/v1/tenants/:id/domain',
    {
      config: { public: true },
      schema: { params: TenantParamsSchema, response: { 200: DomainResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const domain = await domains.findPrimaryTenantDomain(request.params.id);
      if (domain === undefined) throw ProblemError.notFound('No primary domain for that tenant.');
      return { fqdn: domain.fqdn } satisfies Static<typeof DomainResponseSchema>;
    },
  );

  /**
   * `GET /internal/v1/tenants/:id/reseller` (S2-01). trunk-service denormalizes
   * a trunk's owning reseller onto the row itself (05 §3.4: `trunks.reseller_id`)
   * so a reseller-scoped trunk list never needs a cross-schema join (05 §1.1) —
   * this is the one place that denormalized value is looked up, at trunk
   * creation time, the same shape as `/domain` above (S1-09's precedent).
   */
  app.get(
    '/internal/v1/tenants/:id/reseller',
    {
      config: { public: true },
      schema: { params: TenantParamsSchema, response: { 200: ResellerResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const org = await orgs.findById(request.params.id);
      if (org === undefined || org.type !== 'tenant' || org.resellerId === null) {
        throw ProblemError.notFound('No such tenant.');
      }
      return { resellerId: org.resellerId } satisfies Static<typeof ResellerResponseSchema>;
    },
  );

  /**
   * `GET /internal/v1/tenants/:id/country` (S2-04) — how telephony-config
   * learns a tenant's country for E.164 normalization of outbound-dialed
   * numbers (`domain/e164.ts`'s own comment on why). Same shape as
   * `/reseller` above: this service never gets the country from an event
   * (`org.tenant.created`'s payload is deliberately thin), so a consumer
   * that needs it fetches it here, once, at tenant-creation time.
   */
  app.get(
    '/internal/v1/tenants/:id/country',
    {
      config: { public: true },
      schema: { params: TenantParamsSchema, response: { 200: CountryResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const org = await orgs.findById(request.params.id);
      if (org === undefined || org.type !== 'tenant') {
        throw ProblemError.notFound('No such tenant.');
      }
      return { country: org.country } satisfies Static<typeof CountryResponseSchema>;
    },
  );

  /**
   * `GET /internal/v1/tenants/:id/limits` (S2-05) — the raw `orgs.limits`
   * bag, passed through untyped: this service owns *storage* of a tenant's
   * generic limits (05's data table describes the column with no fixed
   * shape, the same way it left `trunks.caller_id_policy` open before
   * S2-04 gave that one a shape), not the *meaning* of any particular key
   * inside it. `domain/fraud-limits.ts` (telephony-config) is what defines
   * and defensively parses the toll-fraud subset
   * (`maxConcurrentChannels`/`maxCallsPerSecond`/`internationalAllowed`/
   * `countryAllowList`) this service has no reason to know about.
   */
  app.get(
    '/internal/v1/tenants/:id/limits',
    {
      config: { public: true },
      schema: { params: TenantParamsSchema, response: { 200: LimitsResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const org = await orgs.findById(request.params.id);
      if (org === undefined || org.type !== 'tenant') {
        throw ProblemError.notFound('No such tenant.');
      }
      return { limits: org.limits } satisfies Static<typeof LimitsResponseSchema>;
    },
  );
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}
