import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import type { BrandRepo } from '../repo/brand.repo.js';
import type { DomainRepo } from '../repo/domain.repo.js';
import type { OrgRepo } from '../repo/org.repo.js';

const TenantParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const DomainResponseSchema = Type.Object({ fqdn: Type.String() });
const ResellerResponseSchema = Type.Object({ resellerId: Type.String() });
const CountryResponseSchema = Type.Object({ country: Type.String() });
const nullableString = Type.Union([Type.String(), Type.Null()]);
const MailBrandResponseSchema = Type.Object({
  /** True when there is no reseller brand: master, or a reseller with none saved. */
  neutral: Type.Boolean(),
  displayName: nullableString,
  primaryColor: nullableString,
  accentColor: nullableString,
  supportEmail: nullableString,
  supportUrl: nullableString,
  supportPhone: nullableString,
  emailFromName: nullableString,
  emailFromAddress: nullableString,
  legalFooter: nullableString,
  /** The reseller's first console hostname, where links in an email should point. */
  consoleHostname: nullableString,
});
const HostParamsSchema = Type.Object({ host: Type.String({ minLength: 1, maxLength: 253 }) });
const SignInScopeResponseSchema = Type.Object({
  /** The org whose users sign in at this console hostname. */
  orgId: Type.String(),
  /** `master` for the unbranded console; `reseller` for a reseller's own hostname. */
  type: Type.Union([Type.Literal('master'), Type.Literal('reseller')]),
});
const LineageResponseSchema = Type.Object({
  orgId: Type.String(),
  type: Type.Union([Type.Literal('master'), Type.Literal('reseller'), Type.Literal('tenant')]),
  /** The org this one sits under; null for the master. */
  parentId: nullableString,
  /** The reseller this org is or belongs to; null for the master. */
  resellerId: nullableString,
});
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
  brands: BrandRepo,
  platformConsoleHostname: string,
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
   * `GET /internal/v1/hosts/:host/sign-in-scope` (S3-04, G-56): which org's
   * users sign in at a console hostname. The platform console hostname is the
   * master's; a reseller's registered console hostname is that reseller's,
   * and its tenants' users sign in there too. Anything else is unknown (404),
   * and the caller falls back to an explicit org id.
   *
   * Internal on purpose. The browser never asks: it finds out whether it must
   * name an org from the sign-in response itself, so there is no public route
   * that maps hostnames to org ids.
   */
  app.get(
    '/internal/v1/hosts/:host/sign-in-scope',
    {
      config: { public: true },
      schema: { params: HostParamsSchema, response: { 200: SignInScopeResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const host = request.params.host.toLowerCase();
      if (host === platformConsoleHostname) {
        const master = await orgs.findMaster();
        if (master === undefined) throw ProblemError.notFound('No such console hostname.');
        return { orgId: master.id, type: 'master' as const };
      }
      const resellerId = await brands.findResellerIdForHostname(host);
      if (resellerId === undefined) throw ProblemError.notFound('No such console hostname.');
      return { orgId: resellerId, type: 'reseller' as const };
    },
  );

  /**
   * `GET /internal/v1/orgs/:id/mail-brand` (S3-03): the brand an email to a
   * user of this org carries (02 §5.2). A tenant sees its reseller's brand, a
   * reseller its own, and the master sees none. notification-service renders
   * with whatever comes back, or the neutral presentation when `neutral` is
   * true, and points links at `consoleHostname`.
   */
  app.get(
    '/internal/v1/orgs/:id/mail-brand',
    {
      config: { public: true },
      schema: { params: TenantParamsSchema, response: { 200: MailBrandResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const org = await orgs.findById(request.params.id);
      if (org === undefined) throw ProblemError.notFound('No such org.');

      const resellerId =
        org.type === 'reseller' ? org.id : org.type === 'tenant' ? org.resellerId : null;
      const brand = resellerId === null ? undefined : await brands.findBrand(resellerId);
      const consoleHostname =
        resellerId === null
          ? null
          : ((await brands.listConsoleHostnames(resellerId))[0]?.fqdn ?? null);

      return {
        neutral: brand === undefined,
        displayName: brand?.displayName ?? null,
        primaryColor: brand?.primaryColor ?? null,
        accentColor: brand?.accentColor ?? null,
        supportEmail: brand?.supportEmail ?? null,
        supportUrl: brand?.supportUrl ?? null,
        supportPhone: brand?.supportPhone ?? null,
        emailFromName: brand?.emailFromName ?? null,
        emailFromAddress: brand?.emailFromAddress ?? null,
        legalFooter: brand?.legalFooter ?? null,
        consoleHostname,
      } satisfies Static<typeof MailBrandResponseSchema>;
    },
  );

  /**
   * `GET /internal/v1/orgs/:id/lineage` (G-62): where an org sits in the tree,
   * so identity-service can tell whether the org a signed-in user names is one
   * they may manage: their own, or (for a reseller) a tenant beneath them, or
   * (for the master) any. Orgs never move, so a caller may cache the answer.
   */
  app.get(
    '/internal/v1/orgs/:id/lineage',
    {
      config: { public: true },
      schema: { params: TenantParamsSchema, response: { 200: LineageResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const org = await orgs.findById(request.params.id);
      if (org === undefined) throw ProblemError.notFound('No such org.');
      return {
        orgId: org.id,
        type: org.type,
        parentId: org.parentId,
        resellerId:
          org.type === 'reseller' ? org.id : org.type === 'tenant' ? org.resellerId : null,
      } satisfies Static<typeof LineageResponseSchema>;
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
