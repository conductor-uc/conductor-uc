import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import { InvalidEmergencyLocationError } from '../domain/emergency-location.js';
import {
  EmergencyLocationInUseError,
  EmergencyLocationNotFoundError,
  type EmergencyLocationRepo,
} from '../repo/emergency-location.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const LocationParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const EmergencyLocationSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  addressLine1: Type.String(),
  addressLine2: Type.Union([Type.String(), Type.Null()]),
  city: Type.String(),
  state: Type.String(),
  postalCode: Type.String(),
  country: Type.String(),
});
type EmergencyLocationResponse = Static<typeof EmergencyLocationSchema>;

const CreateEmergencyLocationBodySchema = Type.Object({
  label: Type.String({ minLength: 1 }),
  addressLine1: Type.String({ minLength: 1 }),
  addressLine2: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  city: Type.String({ minLength: 1 }),
  state: Type.String({ minLength: 1 }),
  postalCode: Type.String({ minLength: 1 }),
  country: Type.String({ minLength: 1 }),
});

const UpdateEmergencyLocationBodySchema = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1 })),
  addressLine1: Type.Optional(Type.String({ minLength: 1 })),
  addressLine2: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  city: Type.Optional(Type.String({ minLength: 1 })),
  state: Type.Optional(Type.String({ minLength: 1 })),
  postalCode: Type.Optional(Type.String({ minLength: 1 })),
  country: Type.Optional(Type.String({ minLength: 1 })),
});

function toResponse(location: {
  id: string;
  label: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}): EmergencyLocationResponse {
  return location;
}

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidEmergencyLocationError) return ProblemError.badRequest(error.message);
  if (error instanceof EmergencyLocationNotFoundError) return ProblemError.notFound(error.message);
  if (error instanceof EmergencyLocationInUseError) {
    return ProblemError.conflict(error.message, { code: 'emergency_location_in_use' });
  }
  throw error;
}

/**
 * Registers `/v1/tenants/{tenantId}/emergency-locations` (S2-06; 05 §3.3,
 * G-1). `emergency_location.manage` — its own permission, not
 * `extension.manage`: a location is shared across extensions (issue #96's
 * own "Site" hint) and a reseller carries the compliance obligation for it
 * (issue #96), which is reason enough to gate it separately even though
 * today both built-in admin roles hold both permissions.
 */
export function registerEmergencyLocationRoutes(
  app: Server,
  locations: EmergencyLocationRepo,
): void {
  app.get(
    '/v1/tenants/:tenantId/emergency-locations',
    {
      config: { permission: 'emergency_location.read', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(EmergencyLocationSchema) }) },
      },
    },
    async (request) => ({ rows: (await locations.list(ctxFor(request))).map(toResponse) }),
  );

  app.get(
    '/v1/tenants/:tenantId/emergency-locations/:id',
    {
      config: { permission: 'emergency_location.read', dataClass: 'config' },
      schema: { params: LocationParamsSchema, response: { 200: EmergencyLocationSchema } },
    },
    async (request) => {
      const found = await locations.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No emergency location with that id.');
      return toResponse(found);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/emergency-locations',
    {
      config: { permission: 'emergency_location.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateEmergencyLocationBodySchema,
        response: { 201: EmergencyLocationSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await locations.create(ctxFor(request), request.body);
        return reply.status(201).send(toResponse(created));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/emergency-locations/:id',
    {
      config: { permission: 'emergency_location.manage', dataClass: 'config' },
      schema: {
        params: LocationParamsSchema,
        body: UpdateEmergencyLocationBodySchema,
        response: { 200: EmergencyLocationSchema },
      },
    },
    async (request) => {
      try {
        return toResponse(await locations.update(ctxFor(request), request.params.id, request.body));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/emergency-locations/:id',
    {
      config: { permission: 'emergency_location.manage', dataClass: 'config' },
      schema: { params: LocationParamsSchema },
    },
    async (request, reply) => {
      try {
        await locations.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );
}
