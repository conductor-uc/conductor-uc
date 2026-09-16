import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import type { DidRepo } from '../repo/did.repo.js';
import type { EmergencyLocationRepo } from '../repo/emergency-location.repo.js';
import type { ExtensionRepo } from '../repo/extension.repo.js';

const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});
const CredentialResponseSchema = Type.Object({
  extensionId: Type.String(),
  number: Type.String(),
  username: Type.String(),
  ha1: Type.String(),
  ha1b: Type.String(),
  realm: Type.String(),
  callerIdName: Type.Union([Type.String(), Type.Null()]),
  callerIdNumber: Type.Union([Type.String(), Type.Null()]),
  emergencyLocationId: Type.String(),
});
const EmergencyLocationResponseSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  addressLine1: Type.String(),
  addressLine2: Type.Union([Type.String(), Type.Null()]),
  city: Type.String(),
  state: Type.String(),
  postalCode: Type.String(),
  country: Type.String(),
});
const DidResponseSchema = Type.Object({
  id: Type.String(),
  e164: Type.String(),
  trunkId: Type.String(),
  destinationType: Type.Union([
    Type.Literal('extension'),
    Type.Literal('ring_group'),
    Type.Literal('flow'),
    Type.Literal('queue'),
    Type.Literal('conference'),
    Type.Literal('voicemail'),
  ]),
  destinationId: Type.String(),
});

/**
 * `GET /internal/v1/tenants/:tenantId/extensions/:id` (S1-12). What
 * telephony-config calls when `pbx.extension.created`/`.updated` fires, to
 * project the extension's digest credential into OpenSIPs' `subscriber`
 * table — the event itself carries only `{ extensionId, number, displayName
 * }` (06: events stay thin; a consumer that needs more state fetches it),
 * and telephony-config keeps no `sip_credentials` of its own (05 §1.1: no
 * cross-schema joins, so it either builds a read model from events or calls
 * the owner's internal API — this is the latter, same shape as
 * org-service's `/internal/v1/tenants/:id/domain`, S1-09).
 *
 * Same gating as that route: a shared `INTERNAL_SERVICE_TOKEN` bearer check
 * inside the handler rather than the `permission`/`dataClass` contract, since
 * there is no real service-to-service auth yet.
 */
export function registerInternalRoutes(
  app: Server,
  extensions: ExtensionRepo,
  dids: DidRepo,
  emergencyLocations: EmergencyLocationRepo,
  internalServiceToken: string,
): void {
  app.get(
    '/internal/v1/tenants/:tenantId/extensions/:id',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: CredentialResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      const credential = await extensions.findCredential({ tenantId }, id);
      if (credential === undefined) {
        throw ProblemError.notFound('No extension with that id in that tenant.');
      }
      return credential satisfies Static<typeof CredentialResponseSchema>;
    },
  );

  /**
   * `GET /internal/v1/tenants/:tenantId/dids/:id` (S2-03) — how
   * telephony-config's `pbx.did.*` consumer re-fetches a DID's current state
   * to project into its own local read model (`pbx.consumer.ts`'s "thin
   * event" pattern, the same shape this file's extension route already
   * serves).
   */
  app.get(
    '/internal/v1/tenants/:tenantId/dids/:id',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: DidResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      const did = await dids.findById({ tenantId }, id);
      if (did === undefined) {
        throw ProblemError.notFound('No DID with that id in that tenant.');
      }
      return {
        id: did.id,
        e164: did.e164,
        trunkId: did.trunkId,
        destinationType: did.destinationType,
        destinationId: did.destinationId,
      } satisfies Static<typeof DidResponseSchema>;
    },
  );

  /**
   * `GET /internal/v1/tenants/:tenantId/emergency-locations/:id` (S2-06;
   * G-1) — how telephony-config resolves a calling extension's
   * `emergencyLocationId` (already on the credential above) to a real,
   * dispatchable address at the moment an emergency call actually needs
   * one. Fetched live, not cached — same reasoning as S2-05's
   * `org-client.ts`'s own `findLimits`: a location correction should take
   * effect on the very next call.
   */
  app.get(
    '/internal/v1/tenants/:tenantId/emergency-locations/:id',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: EmergencyLocationResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      const location = await emergencyLocations.findById({ tenantId }, id);
      if (location === undefined) {
        throw ProblemError.notFound('No emergency location with that id in that tenant.');
      }
      return location satisfies Static<typeof EmergencyLocationResponseSchema>;
    },
  );
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}
