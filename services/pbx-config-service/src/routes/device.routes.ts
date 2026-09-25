import { publishAuditEvent } from '@cuc/audit';
import type { DbContext } from '@cuc/db';
import type { Bus } from '@cuc/events';
import { clientIpOf, ProblemError, Type, type Server } from '@cuc/http';

import { InvalidMacError } from '../domain/provisioning.js';
import {
  DeviceExtensionNotFoundError,
  DeviceMacTakenError,
  DeviceNotFoundError,
  type Device,
  type DeviceRepo,
} from '../repo/device.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const DeviceParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const DeviceSchema = Type.Object({
  id: Type.String(),
  extensionId: Type.String(),
  vendor: Type.String(),
  model: Type.Union([Type.String(), Type.Null()]),
  mac: Type.String(),
  label: Type.Union([Type.String(), Type.Null()]),
  provisioningIssued: Type.Boolean(),
  lastProvisionedAt: Type.Union([Type.String(), Type.Null()]),
  lastSeenIp: Type.Union([Type.String(), Type.Null()]),
  lastUserAgent: Type.Union([Type.String(), Type.Null()]),
});

const CreateDeviceBodySchema = Type.Object({
  extensionId: Type.String({ minLength: 1 }),
  mac: Type.String({ minLength: 1 }),
  model: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
  label: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
});

const UpdateDeviceBodySchema = Type.Object({
  extensionId: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
  label: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
});

const IssueBodySchema = Type.Object({
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});

const CredentialsSchema = Type.Object({
  /** Where the phone fetches its settings. Null until the deployment says what its public address is. */
  url: Type.Union([Type.String(), Type.Null()]),
  /** The Basic-auth user name: the device id. */
  username: Type.String(),
  /** The Basic-auth password. Shown once; issuing again replaces it. */
  password: Type.String(),
  /** `url` with the credentials embedded, for phones that take one address. */
  urlWithCredentials: Type.Union([Type.String(), Type.Null()]),
});

/** The path phones are pointed at; they append `<mac>.cfg` themselves. */
export const YEALINK_PROVISIONING_PATH = '/v1/public/provision/yealink/';

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toResponse(device: Device) {
  return {
    id: device.id,
    extensionId: device.extensionId,
    vendor: device.vendor,
    model: device.model,
    mac: device.mac,
    label: device.label,
    provisioningIssued: device.provisioningIssued,
    lastProvisionedAt: device.lastProvisionedAt?.toISOString() ?? null,
    lastSeenIp: device.lastSeenIp,
    lastUserAgent: device.lastUserAgent,
  };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidMacError) return ProblemError.badRequest(error.message);
  // The same answer whichever tenant holds the address: the reply must not say
  // whose phone it is.
  if (error instanceof DeviceMacTakenError) {
    return ProblemError.conflict('A phone with that MAC address is already set up.', {
      code: 'device_mac_taken',
    });
  }
  if (error instanceof DeviceExtensionNotFoundError) {
    return ProblemError.badRequest(error.message, { code: 'extension_not_found' });
  }
  if (error instanceof DeviceNotFoundError) return ProblemError.notFound(error.message);
  throw error;
}

/** Builds what a phone is told, from the deployment's public base address. */
export function provisioningLocation(
  baseUrl: string | undefined,
  deviceId: string,
  password: string,
): { url: string | null; urlWithCredentials: string | null } {
  if (baseUrl === undefined) return { url: null, urlWithCredentials: null };
  const url = new URL(YEALINK_PROVISIONING_PATH, baseUrl);
  const withCredentials = new URL(url);
  withCredentials.username = deviceId;
  withCredentials.password = password;
  return { url: url.toString(), urlWithCredentials: withCredentials.toString() };
}

/**
 * `/v1/tenants/:tenantId/devices`: the desk phones a tenant has set up, one per
 * MAC address, each tied to an extension. Setting one up needs
 * `extension.manage`. Issuing its provisioning password does not: that password
 * lets whoever holds it fetch the extension's SIP password, so it needs
 * `secret.reveal` and is audited like a reveal.
 */
export function registerDeviceRoutes(
  app: Server,
  devices: DeviceRepo,
  bus: Bus,
  options: { readonly provisioningBaseUrl?: string },
): void {
  app.get(
    '/v1/tenants/:tenantId/devices',
    {
      config: { permission: 'extension.read', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(DeviceSchema) }) },
      },
    },
    async (request) => ({ rows: (await devices.list(ctxFor(request))).map(toResponse) }),
  );

  app.get(
    '/v1/tenants/:tenantId/devices/:id',
    {
      config: { permission: 'extension.read', dataClass: 'config' },
      schema: { params: DeviceParamsSchema, response: { 200: DeviceSchema } },
    },
    async (request) => {
      const found = await devices.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No device with that id.');
      return toResponse(found);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/devices',
    {
      config: { permission: 'extension.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateDeviceBodySchema,
        response: { 201: DeviceSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await devices.create(ctxFor(request), request.body);
        return reply.status(201).send(toResponse(created));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/devices/:id',
    {
      config: { permission: 'extension.manage', dataClass: 'config' },
      schema: {
        params: DeviceParamsSchema,
        body: UpdateDeviceBodySchema,
        response: { 200: DeviceSchema },
      },
    },
    async (request) => {
      try {
        return toResponse(await devices.update(ctxFor(request), request.params.id, request.body));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/devices/:id',
    {
      config: { permission: 'extension.manage', dataClass: 'config' },
      schema: { params: DeviceParamsSchema },
    },
    async (request, reply) => {
      try {
        await devices.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/tenants/:tenantId/devices/:id/provisioning-credentials',
    {
      // Returns a secret that unlocks another secret, so the same permission as reveal.
      config: { permission: 'secret.reveal', dataClass: 'secret' },
      schema: {
        params: DeviceParamsSchema,
        body: IssueBodySchema,
        response: { 200: CredentialsSchema },
      },
    },
    async (request) => {
      const { actorId, actorType, orgId } = request.context;
      if (actorId === undefined || actorType === undefined || orgId === undefined) {
        throw ProblemError.unauthorized(
          'An identified actor is required to issue provisioning credentials.',
        );
      }

      let issued;
      try {
        issued = await devices.issueProvisioningPassword(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }

      await publishAuditEvent(bus, {
        actorType,
        actorId,
        actorOrgId: orgId,
        targetOrgId: request.params.tenantId,
        action: 'device.provisioning.issued',
        resource: request.params.id,
        dataClass: 'secret',
        ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
        ip: clientIpOf(request),
        requestId: request.context.requestId,
      });

      return {
        ...provisioningLocation(options.provisioningBaseUrl, issued.deviceId, issued.password),
        username: issued.deviceId,
        password: issued.password,
      };
    },
  );
}
