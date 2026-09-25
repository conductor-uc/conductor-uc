import { randomUUID } from 'node:crypto';

import type { Storage } from '@cuc/storage';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import { InsufficientContrastError, InvalidColorError } from '../domain/color.js';
import { InvalidFqdnError } from '../domain/domain.js';
import { ConsoleHostnameTakenError, type Brand, type BrandRepo } from '../repo/brand.repo.js';
import type { OrgRepo } from '../repo/org.repo.js';

const OrgIdParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });

const HexColorSchema = Type.String({ pattern: '^#[0-9a-fA-F]{6}$' });

const BrandBodySchema = Type.Object({
  displayName: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
  primaryColor: Type.Optional(Type.Union([HexColorSchema, Type.Null()])),
  accentColor: Type.Optional(Type.Union([HexColorSchema, Type.Null()])),
  logoLightKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  logoDarkKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  faviconKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  supportEmail: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  supportUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  supportPhone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  emailFromName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  emailFromAddress: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  sipUserAgent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  legalFooter: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const BrandSchema = Type.Object({
  resellerId: Type.String(),
  displayName: Type.Union([Type.String(), Type.Null()]),
  primaryColor: Type.Union([Type.String(), Type.Null()]),
  accentColor: Type.Union([Type.String(), Type.Null()]),
  logoLightKey: Type.Union([Type.String(), Type.Null()]),
  logoDarkKey: Type.Union([Type.String(), Type.Null()]),
  faviconKey: Type.Union([Type.String(), Type.Null()]),
  supportEmail: Type.Union([Type.String(), Type.Null()]),
  supportUrl: Type.Union([Type.String(), Type.Null()]),
  supportPhone: Type.Union([Type.String(), Type.Null()]),
  emailFromName: Type.Union([Type.String(), Type.Null()]),
  emailFromAddress: Type.Union([Type.String(), Type.Null()]),
  sipUserAgent: Type.Union([Type.String(), Type.Null()]),
  legalFooter: Type.Union([Type.String(), Type.Null()]),
});

const AssetKindSchema = Type.Union([
  Type.Literal('logoLight'),
  Type.Literal('logoDark'),
  Type.Literal('favicon'),
]);
const RequestAssetUploadBodySchema = Type.Object({
  kind: AssetKindSchema,
  contentType: Type.String({ minLength: 1 }),
});

const RegisterHostnameBodySchema = Type.Object({ fqdn: Type.String({ minLength: 1 }) });
const ConsoleHostnameSchema = Type.Object({
  fqdn: Type.String(),
  resellerId: Type.String(),
  tlsStatus: Type.String(),
});

const PublicBrandSchema = Type.Union([
  Type.Object({ neutral: Type.Literal(true) }),
  Type.Object({
    neutral: Type.Literal(false),
    displayName: Type.Union([Type.String(), Type.Null()]),
    primaryColor: Type.Union([Type.String(), Type.Null()]),
    accentColor: Type.Union([Type.String(), Type.Null()]),
    logoLightUrl: Type.Union([Type.String(), Type.Null()]),
    logoDarkUrl: Type.Union([Type.String(), Type.Null()]),
    faviconUrl: Type.Union([Type.String(), Type.Null()]),
    supportEmail: Type.Union([Type.String(), Type.Null()]),
    supportUrl: Type.Union([Type.String(), Type.Null()]),
    supportPhone: Type.Union([Type.String(), Type.Null()]),
    legalFooter: Type.Union([Type.String(), Type.Null()]),
  }),
]);

function toResponse(brand: Brand): Brand {
  return brand;
}

/** The brand as a visitor sees it: colors, text, and short-lived asset URLs. */
async function presentBrand(
  brand: Brand | undefined,
  storage: Storage,
): Promise<Static<typeof PublicBrandSchema>> {
  if (brand === undefined) return { neutral: true as const };
  const platform = storage.forPlatform();
  return {
    neutral: false as const,
    displayName: brand.displayName,
    primaryColor: brand.primaryColor,
    accentColor: brand.accentColor,
    logoLightUrl:
      brand.logoLightKey === null ? null : await platform.presignGet(brand.logoLightKey),
    logoDarkUrl: brand.logoDarkKey === null ? null : await platform.presignGet(brand.logoDarkKey),
    faviconUrl: brand.faviconKey === null ? null : await platform.presignGet(brand.faviconKey),
    supportEmail: brand.supportEmail,
    supportUrl: brand.supportUrl,
    supportPhone: brand.supportPhone,
    legalFooter: brand.legalFooter,
  };
}

/**
 * Registers reseller brand CRUD, brand asset upload, console hostname
 * registration, and the public brand-resolution endpoint (S1-04; 02 §5).
 *
 * `platformConsoleHostname` is `console.{PLATFORM_BASE_DOMAIN}` (02 §3's
 * table) — the one hostname that means "master, always neutral" rather than
 * "unregistered, so also neutral". Both outcomes look the same on the wire;
 * the distinction only matters for which of the four resolution branches a
 * test is exercising.
 */
export function registerBrandRoutes(
  app: Server,
  repo: BrandRepo,
  storage: Storage,
  platformConsoleHostname: string,
  orgs: OrgRepo,
): void {
  app.put(
    '/v1/resellers/:id/brand',
    {
      config: { permission: 'brand.manage', dataClass: 'config' },
      schema: { params: OrgIdParamsSchema, body: BrandBodySchema, response: { 200: BrandSchema } },
    },
    async (request) => {
      try {
        const brand = await repo.upsertBrand(request.context, request.params.id, request.body);
        return toResponse(brand);
      } catch (error) {
        if (error instanceof InvalidColorError) throw ProblemError.badRequest(error.message);
        if (error instanceof InsufficientContrastError) {
          throw ProblemError.badRequest(error.message, { code: 'insufficient_contrast' });
        }
        throw error;
      }
    },
  );

  app.get(
    '/v1/resellers/:id/brand',
    {
      config: { permission: 'brand.read', dataClass: 'config' },
      schema: { params: OrgIdParamsSchema, response: { 200: BrandSchema } },
    },
    async (request) => {
      const brand = await repo.findBrand(request.params.id);
      if (brand === undefined)
        throw ProblemError.notFound('No brand configured for that reseller.');
      return toResponse(brand);
    },
  );

  app.post(
    '/v1/resellers/:id/brand/assets',
    {
      config: { permission: 'brand.manage', dataClass: 'config' },
      schema: {
        params: OrgIdParamsSchema,
        body: RequestAssetUploadBodySchema,
        response: { 201: Type.Object({ uploadUrl: Type.String(), key: Type.String() }) },
      },
    },
    async (request, reply) => {
      const key = `brand/${request.params.id}/${request.body.kind}-${randomUUID()}`;
      const uploadUrl = await storage
        .forPlatform()
        .presignPut(key, { contentType: request.body.contentType });
      return reply.status(201).send({ uploadUrl, key });
    },
  );

  app.post(
    '/v1/resellers/:id/console-hostnames',
    {
      config: { permission: 'brand.manage', dataClass: 'config' },
      schema: {
        params: OrgIdParamsSchema,
        body: RegisterHostnameBodySchema,
        response: { 201: ConsoleHostnameSchema },
      },
    },
    async (request, reply) => {
      try {
        const hostname = await repo.registerConsoleHostname(request.params.id, request.body.fqdn);
        return reply.status(201).send(hostname);
      } catch (error) {
        if (error instanceof InvalidFqdnError) throw ProblemError.badRequest(error.message);
        if (error instanceof ConsoleHostnameTakenError) {
          throw ProblemError.conflict(error.message, { code: 'console_hostname_taken' });
        }
        throw error;
      }
    },
  );

  app.get(
    '/v1/resellers/:id/console-hostnames',
    {
      config: { permission: 'brand.read', dataClass: 'config' },
      schema: {
        params: OrgIdParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(ConsoleHostnameSchema) }) },
      },
    },
    async (request) => ({ rows: await repo.listConsoleHostnames(request.params.id) }),
  );

  app.get(
    '/v1/public/brand',
    {
      config: { public: true },
      schema: {
        querystring: Type.Object({ host: Type.String({ minLength: 1 }) }),
        response: { 200: PublicBrandSchema },
      },
    },
    async (request) => {
      const host = request.query.host.toLowerCase();
      if (host === platformConsoleHostname) return { neutral: true as const };

      const resellerId = await repo.findResellerIdForHostname(host);
      if (resellerId === undefined) return { neutral: true as const };

      return presentBrand(await repo.findBrand(resellerId), storage);
    },
  );

  /**
   * The brand the signed-in actor's own org is presented with (S3-02): a
   * tenant sees its reseller's, a reseller its own, the master none. The
   * console re-themes from this after login, when the hostname alone did not
   * say which brand applies. Reads only the actor's own org, from the verified
   * request context, so there is no id to guess.
   */
  app.get(
    '/v1/session/brand',
    {
      config: { permission: 'org.view', dataClass: 'config' },
      schema: { response: { 200: PublicBrandSchema } },
    },
    async (request) => {
      const orgId = request.context.orgId;
      if (orgId === undefined) throw ProblemError.unauthorized('Sign in to continue.');
      const org = await orgs.findById(orgId);
      if (org === undefined) throw ProblemError.notFound('No such org.');
      const resellerId =
        org.type === 'reseller' ? org.id : org.type === 'tenant' ? org.resellerId : null;
      if (resellerId === null) return { neutral: true as const };
      return presentBrand(await repo.findBrand(resellerId), storage);
    },
  );
}
