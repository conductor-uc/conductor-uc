import { ProblemError, Type, type Server } from '@cuc/http';

import { InvalidOrgHierarchyError, InvalidOrgStatusTransitionError } from '../domain/org.js';
import type { AdminUserCreator } from '../identity-client.js';
import { AdminUserEmailTakenError } from '../identity-client.js';
import {
  OrgNotFoundError,
  ParentNotFoundError,
  SlugTakenError,
  type Org,
  type OrgRepo,
} from '../repo/org.repo.js';

const SlugSchema = Type.String({
  minLength: 2,
  maxLength: 63,
  pattern: '^[a-z0-9][a-z0-9-]*[a-z0-9]$',
});
const NameSchema = Type.String({ minLength: 1, maxLength: 255 });
/** Matches identity-service's own minimum (S1-05) — fail fast, client-side. */
const PasswordSchema = Type.String({ minLength: 12 });

const OrgSchema = Type.Object({
  id: Type.String(),
  type: Type.Union([Type.Literal('master'), Type.Literal('reseller'), Type.Literal('tenant')]),
  parentId: Type.Union([Type.String(), Type.Null()]),
  resellerId: Type.Union([Type.String(), Type.Null()]),
  slug: Type.String(),
  name: Type.String(),
  status: Type.Union([
    Type.Literal('active'),
    Type.Literal('suspended'),
    Type.Literal('pending_deletion'),
    Type.Literal('deleted'),
  ]),
  timezone: Type.String(),
  country: Type.String(),
  limits: Type.Record(Type.String(), Type.Unknown()),
});

const CreatedOrgSchema = Type.Object({
  ...OrgSchema.properties,
  adminUser: Type.Object({ id: Type.String(), email: Type.String() }),
});

const CreateOrgBodySchema = Type.Object({
  slug: SlugSchema,
  name: NameSchema,
  adminEmail: Type.String({ minLength: 1 }),
  adminDisplayName: Type.String({ minLength: 1 }),
  adminPassword: PasswordSchema,
});

const UpdateOrgBodySchema = Type.Object({
  name: Type.Optional(NameSchema),
  timezone: Type.Optional(Type.String({ minLength: 1 })),
  country: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
  limits: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const IdParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });

function toResponse(org: Org): Org {
  return org;
}

/**
 * Registers the reseller and tenant provisioning API (S1-02; 06's org-service
 * section). Resellers and tenants only — the master exists once, created only
 * by `bootstrap-master` (02 §1), never through this API.
 *
 * H3 (only the master may create or manage a reseller) is enforced generically
 * by `@cuc/http`'s `registerHardRules` from the `permission` declared below,
 * using only the caller's org type — no role lookup needed, since H3 is
 * master-only unconditionally. Which specific actors may create a *tenant*
 * (reseller_admin and master_admin, per the built-in roles — never
 * tenant_admin) is role-gated rather than hard-ruled, and role resolution is
 * not wired into any service's request context yet (that lands with
 * api-gateway, S1-08) — so, like every other route in this codebase so far,
 * `tenant.create` here is declared but not yet actively checked per request.
 *
 * "A reseller cannot see another reseller's tenants" holds structurally:
 * `GET /v1/resellers/:id/tenants` only ever returns rows whose `parent_id` is
 * the `:id` in the URL. It does not yet stop a reseller from *naming* a
 * different reseller's id in that URL — the same acknowledged gap
 * `example-service`'s template leaves open, for the same reason (no trusted
 * per-request actor identity to compare the URL against yet).
 */
export function registerOrgRoutes(
  app: Server,
  repo: OrgRepo,
  createAdminUser: AdminUserCreator,
): void {
  async function requireMaster(): Promise<Org> {
    const master = await repo.findMaster();
    if (master === undefined) {
      throw ProblemError.unavailable('The master org has not been bootstrapped yet.');
    }
    return master;
  }

  async function createOrgWithAdmin(
    parentId: string,
    type: 'reseller' | 'tenant',
    body: {
      readonly slug: string;
      readonly name: string;
      readonly adminEmail: string;
      readonly adminDisplayName: string;
      readonly adminPassword: string;
    },
  ): Promise<{ org: Org; adminUser: { id: string; email: string } }> {
    let org: Org;
    try {
      org = await repo.create({}, type, { parentId, slug: body.slug, name: body.name });
    } catch (error) {
      if (error instanceof ParentNotFoundError) throw ProblemError.notFound(error.message);
      if (error instanceof SlugTakenError) {
        throw ProblemError.conflict(error.message, { code: 'slug_taken' });
      }
      if (error instanceof InvalidOrgHierarchyError) throw ProblemError.badRequest(error.message);
      throw error;
    }

    try {
      const adminUser = await createAdminUser({
        orgId: org.id,
        orgType: type,
        resellerId: type === 'tenant' ? parentId : null,
        email: body.adminEmail,
        displayName: body.adminDisplayName,
        password: body.adminPassword,
      });
      return { org, adminUser };
    } catch (error) {
      // The org row already committed — creating it and creating its admin
      // user cannot be one transaction across two services' databases (05
      // §1.1). Nothing here retries or rolls back; the org exists without an
      // admin user, and the caller sees exactly that in the error so an
      // operator can act on it rather than silently losing the failure.
      if (error instanceof AdminUserEmailTakenError) {
        throw ProblemError.conflict(
          `${org.type} '${org.id}' was created, but its admin user was not: ${error.message}`,
          { code: 'admin_email_taken' },
        );
      }
      throw ProblemError.unavailable(
        `${org.type} '${org.id}' was created, but its admin user was not: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'admin_user_creation_failed' },
      );
    }
  }

  app.post(
    '/v1/resellers',
    {
      config: { permission: 'reseller.create', dataClass: 'config' },
      schema: { body: CreateOrgBodySchema, response: { 201: CreatedOrgSchema } },
    },
    async (request, reply) => {
      const master = await requireMaster();
      const { org, adminUser } = await createOrgWithAdmin(master.id, 'reseller', request.body);
      return reply.status(201).send({ ...toResponse(org), adminUser });
    },
  );

  app.get(
    '/v1/resellers',
    {
      config: { permission: 'reseller.read', dataClass: 'config' },
      schema: { response: { 200: Type.Object({ rows: Type.Array(OrgSchema) }) } },
    },
    async () => {
      const master = await requireMaster();
      return { rows: (await repo.listChildren(master.id)).map(toResponse) };
    },
  );

  app.get(
    '/v1/resellers/:id',
    {
      config: { permission: 'reseller.read', dataClass: 'config' },
      schema: { params: IdParamsSchema, response: { 200: OrgSchema } },
    },
    async (request) => {
      const org = await repo.findById(request.params.id);
      if (org === undefined || org.type !== 'reseller') {
        throw ProblemError.notFound('No reseller with that id.');
      }
      return toResponse(org);
    },
  );

  app.patch(
    '/v1/resellers/:id',
    {
      config: { permission: 'reseller.manage', dataClass: 'config' },
      schema: { params: IdParamsSchema, body: UpdateOrgBodySchema, response: { 200: OrgSchema } },
    },
    async (request) =>
      toResponse(await updateOrg(repo, 'reseller', request.params.id, request.body)),
  );

  app.post(
    '/v1/resellers/:id/suspend',
    {
      config: { permission: 'reseller.manage', dataClass: 'config' },
      schema: { params: IdParamsSchema, response: { 200: OrgSchema } },
    },
    async (request) =>
      toResponse(await transitionOrg(repo, 'reseller', 'suspend', request.params.id)),
  );

  app.post(
    '/v1/resellers/:id/resume',
    {
      config: { permission: 'reseller.manage', dataClass: 'config' },
      schema: { params: IdParamsSchema, response: { 200: OrgSchema } },
    },
    async (request) =>
      toResponse(await transitionOrg(repo, 'reseller', 'resume', request.params.id)),
  );

  app.post(
    '/v1/resellers/:id/tenants',
    {
      config: { permission: 'tenant.create', dataClass: 'config' },
      schema: {
        params: IdParamsSchema,
        body: CreateOrgBodySchema,
        response: { 201: CreatedOrgSchema },
      },
    },
    async (request, reply) => {
      const { org, adminUser } = await createOrgWithAdmin(
        request.params.id,
        'tenant',
        request.body,
      );
      return reply.status(201).send({ ...toResponse(org), adminUser });
    },
  );

  app.get(
    '/v1/resellers/:id/tenants',
    {
      config: { permission: 'tenant.read', dataClass: 'config' },
      schema: {
        params: IdParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(OrgSchema) }) },
      },
    },
    async (request) => ({ rows: (await repo.listChildren(request.params.id)).map(toResponse) }),
  );

  app.get(
    '/v1/tenants/:id',
    {
      config: { permission: 'tenant.read', dataClass: 'config' },
      schema: { params: IdParamsSchema, response: { 200: OrgSchema } },
    },
    async (request) => {
      const org = await repo.findById(request.params.id);
      if (org === undefined || org.type !== 'tenant') {
        throw ProblemError.notFound('No tenant with that id.');
      }
      return toResponse(org);
    },
  );

  app.patch(
    '/v1/tenants/:id',
    {
      config: { permission: 'tenant.manage', dataClass: 'config' },
      schema: { params: IdParamsSchema, body: UpdateOrgBodySchema, response: { 200: OrgSchema } },
    },
    async (request) => toResponse(await updateOrg(repo, 'tenant', request.params.id, request.body)),
  );

  app.post(
    '/v1/tenants/:id/suspend',
    {
      config: { permission: 'tenant.suspend', dataClass: 'config' },
      schema: { params: IdParamsSchema, response: { 200: OrgSchema } },
    },
    async (request) =>
      toResponse(await transitionOrg(repo, 'tenant', 'suspend', request.params.id)),
  );

  app.post(
    '/v1/tenants/:id/resume',
    {
      config: { permission: 'tenant.suspend', dataClass: 'config' },
      schema: { params: IdParamsSchema, response: { 200: OrgSchema } },
    },
    async (request) => toResponse(await transitionOrg(repo, 'tenant', 'resume', request.params.id)),
  );
}

async function updateOrg(
  repo: OrgRepo,
  expectedType: 'reseller' | 'tenant',
  id: string,
  patch: {
    readonly name?: string;
    readonly timezone?: string;
    readonly country?: string;
    readonly limits?: Record<string, unknown>;
  },
): Promise<Org> {
  await requireType(repo, expectedType, id);
  try {
    return await repo.update({}, id, patch);
  } catch (error) {
    if (error instanceof OrgNotFoundError) throw ProblemError.notFound(error.message);
    if (error instanceof InvalidOrgHierarchyError) throw ProblemError.badRequest(error.message);
    throw error;
  }
}

async function transitionOrg(
  repo: OrgRepo,
  expectedType: 'reseller' | 'tenant',
  action: 'suspend' | 'resume',
  id: string,
): Promise<Org> {
  await requireType(repo, expectedType, id);
  try {
    return await (action === 'suspend' ? repo.suspend({}, id) : repo.resume({}, id));
  } catch (error) {
    if (error instanceof OrgNotFoundError) throw ProblemError.notFound(error.message);
    if (error instanceof InvalidOrgHierarchyError) throw ProblemError.badRequest(error.message);
    if (error instanceof InvalidOrgStatusTransitionError) {
      throw ProblemError.conflict(error.message, { code: 'invalid_status_transition' });
    }
    throw error;
  }
}

/** 404s on a well-formed id that names an org of the wrong type, e.g. a tenant id under `/v1/resellers/:id`. */
async function requireType(
  repo: OrgRepo,
  expectedType: 'reseller' | 'tenant',
  id: string,
): Promise<void> {
  const org = await repo.findById(id);
  if (org === undefined || org.type !== expectedType) {
    throw ProblemError.notFound(`No ${expectedType} with that id.`);
  }
}
