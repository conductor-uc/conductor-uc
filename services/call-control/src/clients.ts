import type { RecordingCallDirection } from '@cuc/api-contracts';

/**
 * The services call-control asks when someone acts on a live call. For a recording button (S5-15):
 * recording-service, which decides and audits, and pbx-config-service, which says which extension
 * is a person's own. For listening, whispering or barging (S5-09) also: pbx-config-service again,
 * for the extensions and queues a call touches, and org-service, for the tenant's SIP domain.
 * Same shared bearer token as every internal call (07 §1).
 */

export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';
}

interface ClientOptions {
  /** e.g. `http://recording-service:8080`. No trailing slash required. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  readonly timeoutMs?: number;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

async function call(
  options: ClientOptions,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    return await fetchImpl(`${options.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${options.internalServiceToken}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch (error) {
    throw new UpstreamError(error instanceof Error ? error.message : String(error));
  }
}

/** The explicit recording actions (recording-service's `action`). */
export type RecordingAction = 'start' | 'stop' | 'pause' | 'resume';

export interface RecordingControlRequest {
  readonly tenantId: string;
  readonly action: RecordingAction;
  /** The channel that owns the call's recording (`cuc_rec_owner`). */
  readonly callUuid: string;
  readonly recordingId?: string;
  readonly nodeId: string;
  readonly context: {
    readonly direction: RecordingCallDirection;
    readonly extensionIds: readonly string[];
    readonly queueId?: string | undefined;
    readonly didId?: string | undefined;
  };
  /** The person who pressed the button; audited as them. */
  readonly actor: { readonly id: string; readonly orgId: string };
  readonly ip?: string;
  readonly requestId?: string;
}

export interface RecordingControlAnswer {
  readonly result: 'started' | 'stopped' | 'paused' | 'resumed' | 'refused';
  readonly recordingId: string | null;
  readonly reason: string | null;
}

/** Asks recording-service (`POST /internal/v1/recordings/control`). Throws {@link UpstreamError} when it cannot answer. */
export type RecordingControlClient = (
  request: RecordingControlRequest,
) => Promise<RecordingControlAnswer>;

export function createRecordingControlClient(options: ClientOptions): RecordingControlClient {
  return async (request) => {
    const { context, ...rest } = request;
    const response = await call(options, '/internal/v1/recordings/control', {
      method: 'POST',
      body: {
        ...rest,
        context: {
          direction: context.direction,
          extensionIds: [...context.extensionIds],
          ...(context.queueId === undefined ? {} : { queueId: context.queueId }),
          ...(context.didId === undefined ? {} : { didId: context.didId }),
        },
      },
    });
    if (!response.ok) {
      throw new UpstreamError(`recording-service answered ${String(response.status)}`);
    }
    const body = (await response.json()) as Partial<RecordingControlAnswer>;
    const results = ['started', 'stopped', 'paused', 'resumed', 'refused'];
    if (typeof body.result !== 'string' || !results.includes(body.result)) {
      throw new UpstreamError('recording-service gave an answer this service cannot read');
    }
    return {
      result: body.result,
      recordingId: typeof body.recordingId === 'string' ? body.recordingId : null,
      reason: typeof body.reason === 'string' ? body.reason : null,
    };
  };
}

export interface UserExtension {
  readonly extensionId: string;
  readonly number: string;
}

/**
 * Which extension belongs to a person (pbx-config-service's
 * `GET /internal/v1/tenants/:tenantId/users/:userId/extension`, parity 1e), the same lookup the
 * other self-service routes use. `undefined` when none is linked; throws {@link UpstreamError}
 * when it cannot be asked.
 */
export type UserExtensionLookup = (
  tenantId: string,
  userId: string,
) => Promise<UserExtension | undefined>;

export function createUserExtensionLookup(options: ClientOptions): UserExtensionLookup {
  return async (tenantId, userId) => {
    const response = await call(
      options,
      `/internal/v1/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/extension`,
      { method: 'GET' },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new UpstreamError(`pbx-config-service answered ${String(response.status)}`);
    }
    const body = (await response.json()) as Partial<UserExtension>;
    if (typeof body.extensionId !== 'string' || typeof body.number !== 'string') {
      throw new UpstreamError('pbx-config-service gave an answer this service cannot read');
    }
    return { extensionId: body.extensionId, number: body.number };
  };
}

export interface ExtensionScope {
  readonly extensionId: string;
  readonly number: string;
  /** The queues the extension answers as an agent. */
  readonly agentQueueIds: readonly string[];
  /** The same queues with their labels (S9-20), when pbx-config-service names them. */
  readonly agentQueues?: readonly { readonly id: string; readonly label: string }[];
}

/**
 * S5-09: which extension a live leg's number is, and which queues it answers as an agent
 * (pbx-config-service's `GET /internal/v1/tenants/:tenantId/extensions/by-number/:number`), to
 * match a monitoring grant scoped to an extension or a queue. `undefined` when the tenant has no
 * such extension; throws {@link UpstreamError} when it cannot be asked.
 */
export type ExtensionScopeLookup = (
  tenantId: string,
  number: string,
) => Promise<ExtensionScope | undefined>;

export function createExtensionScopeLookup(options: ClientOptions): ExtensionScopeLookup {
  return async (tenantId, number) => {
    const response = await call(
      options,
      `/internal/v1/tenants/${encodeURIComponent(tenantId)}/extensions/by-number/${encodeURIComponent(number)}`,
      { method: 'GET' },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new UpstreamError(`pbx-config-service answered ${String(response.status)}`);
    }
    const body = (await response.json()) as Partial<ExtensionScope>;
    if (
      typeof body.extensionId !== 'string' ||
      typeof body.number !== 'string' ||
      !Array.isArray(body.agentQueueIds) ||
      !body.agentQueueIds.every((id) => typeof id === 'string')
    ) {
      throw new UpstreamError('pbx-config-service gave an answer this service cannot read');
    }
    const listed: unknown = body.agentQueues;
    const named = Array.isArray(listed)
      ? (listed as unknown[]).filter(
          (queue): queue is { id: string; label: string } =>
            typeof queue === 'object' &&
            queue !== null &&
            typeof (queue as Record<string, unknown>)['id'] === 'string' &&
            typeof (queue as Record<string, unknown>)['label'] === 'string',
        )
      : undefined;
    return {
      extensionId: body.extensionId,
      number: body.number,
      agentQueueIds: body.agentQueueIds,
      ...(named === undefined
        ? {}
        : { agentQueues: named.map((queue) => ({ id: queue.id, label: queue.label })) }),
    };
  };
}

export interface ParkingLotSlots {
  readonly id: string;
  readonly slotStart: number;
  readonly slotEnd: number;
}

/**
 * S9-12: a parking lot's slots (pbx-config-service's
 * `GET /internal/v1/tenants/:tenantId/parking-lots/:id`), to park a call in the first free one.
 * `undefined` when the tenant has no such lot; throws {@link UpstreamError} when it cannot be asked.
 */
export type ParkingLotLookup = (
  tenantId: string,
  lotId: string,
) => Promise<ParkingLotSlots | undefined>;

export function createParkingLotLookup(options: ClientOptions): ParkingLotLookup {
  return async (tenantId, lotId) => {
    const response = await call(
      options,
      `/internal/v1/tenants/${encodeURIComponent(tenantId)}/parking-lots/${encodeURIComponent(lotId)}`,
      { method: 'GET' },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new UpstreamError(`pbx-config-service answered ${String(response.status)}`);
    }
    const body = (await response.json()) as Partial<ParkingLotSlots>;
    if (
      typeof body.id !== 'string' ||
      !Number.isInteger(body.slotStart) ||
      !Number.isInteger(body.slotEnd)
    ) {
      throw new UpstreamError('pbx-config-service gave an answer this service cannot read');
    }
    return { id: body.id, slotStart: body.slotStart!, slotEnd: body.slotEnd! };
  };
}

/**
 * S9-18 (G-125): the extension numbers whose ringing calls [number] may pick up: every other
 * member of its pickup groups (pbx-config-service's
 * `GET /internal/v1/tenants/:t/extensions/by-number/:number/pickup-peers`). Empty when none;
 * throws {@link UpstreamError} when it cannot be asked.
 */
export type PickupPeersLookup = (tenantId: string, number: string) => Promise<string[]>;

export function createPickupPeersLookup(options: ClientOptions): PickupPeersLookup {
  return async (tenantId, number) => {
    const response = await call(
      options,
      `/internal/v1/tenants/${encodeURIComponent(tenantId)}/extensions/by-number/${encodeURIComponent(number)}/pickup-peers`,
      { method: 'GET' },
    );
    if (!response.ok) {
      throw new UpstreamError(`pbx-config-service answered ${String(response.status)}`);
    }
    const body = (await response.json()) as { numbers?: unknown };
    if (!Array.isArray(body.numbers) || !body.numbers.every((n) => typeof n === 'string')) {
      throw new UpstreamError('pbx-config-service gave an answer this service cannot read');
    }
    return body.numbers;
  };
}

/**
 * S5-09: a tenant's SIP domain (org-service's `GET /internal/v1/tenants/:id/domain`), which a
 * supervisor's phone is registered under, so the call to it can be routed through OpenSIPs.
 * `undefined` when the tenant has none; throws {@link UpstreamError} when it cannot be asked.
 */
export type TenantDomainLookup = (tenantId: string) => Promise<string | undefined>;

export function createTenantDomainLookup(options: ClientOptions): TenantDomainLookup {
  return async (tenantId) => {
    const response = await call(
      options,
      `/internal/v1/tenants/${encodeURIComponent(tenantId)}/domain`,
      { method: 'GET' },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw new UpstreamError(`org-service answered ${String(response.status)}`);
    const body = (await response.json()) as { fqdn?: unknown };
    if (typeof body.fqdn !== 'string') {
      throw new UpstreamError('org-service gave an answer this service cannot read');
    }
    return body.fqdn;
  };
}

/**
 * G-119 (3): which tenant a domain belongs to (org-service's `GET /internal/v1/tenant-domains/:fqdn`),
 * for a queue agent's events. Domains rarely change owner, so an answer is kept for `ttlMs`
 * (default 5 minutes) and "nobody" for a minute; the cache is bounded. Throws
 * {@link UpstreamError} when org-service cannot be asked.
 */
export function createTenantByDomainLookup(
  options: ClientOptions & { readonly ttlMs?: number; readonly now?: () => number },
): (fqdn: string) => Promise<string | undefined> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const cache = new Map<string, { tenantId: string | undefined; until: number }>();
  return async (fqdn) => {
    const key = fqdn.toLowerCase();
    const hit = cache.get(key);
    if (hit !== undefined && hit.until > now()) return hit.tenantId;
    const response = await call(options, `/internal/v1/tenant-domains/${encodeURIComponent(key)}`, {
      method: 'GET',
    });
    let tenantId: string | undefined;
    if (response.status === 404) {
      tenantId = undefined;
    } else if (response.ok) {
      const body = (await response.json()) as { tenantId?: unknown };
      if (typeof body.tenantId !== 'string') {
        throw new UpstreamError('org-service gave an answer this service cannot read');
      }
      tenantId = body.tenantId;
    } else {
      throw new UpstreamError(`org-service answered ${String(response.status)}`);
    }
    if (cache.size > 10_000) cache.clear();
    cache.set(key, { tenantId, until: now() + (tenantId === undefined ? 60_000 : ttlMs) });
    return tenantId;
  };
}
