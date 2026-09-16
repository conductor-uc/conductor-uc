import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';
import type { Logger } from '@cuc/logger';

import type { OpenSipsMiClient } from '../opensips-mi-client.js';
import { registrantKeyFor } from '../projection.js';
import type { ReadModelRepo } from '../repo/read-model.repo.js';

const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});
const StatusResponseSchema = Type.Object({
  status: Type.Union([
    Type.Literal('registered'),
    Type.Literal('registering'),
    Type.Literal('failed'),
    Type.Literal('not_registered'),
    Type.Literal('not_applicable'),
  ]),
});
type StatusResponse = Static<typeof StatusResponseSchema>;

/**
 * `reg_list`'s per-record `state` field — confirmed live against a real
 * OpenSIPs 3.6.8 instance: scoped to one record (the `(aor, contact,
 * registrar)` 3-param form this route uses), the live MI response reports
 * the human-readable label (`"REGISTERED_STATE"`), not the numeric code
 * `README.uac_registrant.gz` documents for the DB column — both are
 * accepted here since which one a given OpenSIPs build/version returns is
 * not otherwise documented.
 */
function statusFromState(state: unknown): StatusResponse['status'] {
  switch (state) {
    case 3:
    case 'REGISTERED_STATE':
      return 'registered';
    case 1:
    case 2:
    case 'REGISTERING_STATE':
    case 'AUTHENTICATING_STATE':
      return 'registering';
    case 0:
    case 'NOT_REGISTERED_STATE':
      return 'not_registered';
    default: // TIMEOUT/INTERNAL_ERROR/WRONG_CREDENTIALS/REGISTRAR_ERROR states
      return 'failed';
  }
}

/**
 * `reg_list`'s result shape depends on whether it was scoped to one record
 * — confirmed live: the unscoped (no-params) form wraps every record in
 * `{ Records: [...] }`, but the 3-param `(aor, contact, registrar)` form
 * this route always uses returns a single `{ Registrant: {...} }` instead.
 * Both are accepted so a future caller of this same MI client method (an
 * unscoped listing, say) is not surprised by which shape it gets.
 */
interface RegListResult {
  readonly Records?: readonly { readonly state?: unknown; readonly State?: unknown }[];
  readonly Registrant?: { readonly state?: unknown; readonly State?: unknown };
}

/**
 * `GET /internal/v1/tenants/:tenantId/trunks/:id/status` (S2-02) — what
 * trunk-service's public `:status` action (06) calls, since only this
 * service holds the OpenSIPs MI connection (05 §1.1). Reads `uac_registrant`'s
 * live, in-memory state via `reg_list`, not this service's own local mirror
 * or a direct SQL read of `registrant.state`: the module's DB row is not
 * necessarily kept current with what it actually last did on the wire, but
 * its in-memory state (what `reg_list` reports) always is.
 *
 * Same gating as every other `/internal/v1` route (07 §1's precedent): a
 * shared `INTERNAL_SERVICE_TOKEN` bearer check inside the handler.
 */
export function registerInternalRoutes(
  app: Server,
  readModel: ReadModelRepo,
  mi: OpenSipsMiClient,
  opensipsSipUri: string,
  internalServiceToken: string,
  logger: Logger,
): void {
  app.get(
    '/internal/v1/tenants/:tenantId/trunks/:id/status',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: StatusResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      const trunk = await readModel.findTrunkById(id);
      if (trunk === undefined || trunk.tenantId !== tenantId) {
        throw ProblemError.notFound('No trunk with that id in that tenant.');
      }

      const needsRegistration = trunk.authMode === 'register' || trunk.authMode === 'both';
      if (!needsRegistration) {
        return { status: 'not_applicable' } satisfies StatusResponse;
      }

      const key = registrantKeyFor(trunk, opensipsSipUri);
      let result: RegListResult;
      try {
        result = await mi.query<RegListResult>('reg_list', [key.aor, key.bindingUri, key.registrar]);
      } catch (error) {
        logger.warn({ err: error, trunkId: id }, 'reg_list failed; reporting status as failed');
        return { status: 'failed' } satisfies StatusResponse;
      }

      const record = result.Registrant ?? result.Records?.[0];
      if (record === undefined) return { status: 'not_registered' } satisfies StatusResponse;
      return { status: statusFromState(record.state ?? record.State) } satisfies StatusResponse;
    },
  );
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}
