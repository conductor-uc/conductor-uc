import { allowed, type Permission, type Scope } from '@cuc/authz';
import type { AccessClient, ActorAccess } from '@cuc/http';

import { liveCallFromSnapshot, type LiveCall } from './calls.js';
import type { CallScope } from './user-calls.js';
import type { ExtensionStatus } from './presence.js';

/** Where an org sits in the tree (org-service's `GET /internal/v1/orgs/:id/lineage`). */
export interface OrgLineage {
  readonly type: 'master' | 'reseller' | 'tenant';
  readonly resellerId: string | null;
}

/** Undefined when there is no such org. Throws when org-service cannot be asked. */
export type LineageLookup = (orgId: string) => Promise<OrgLineage | undefined>;

/** The tenant's live calls now. Throws when call-control cannot be asked. */
export type LiveCallsSource = (tenantId: string) => Promise<LiveCall[]>;

export class SourceUnavailableError extends Error {
  override readonly name = 'SourceUnavailableError';
}

interface InternalClientOptions {
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

async function internalGet(
  options: InternalClientOptions,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, '')}${path}`, {
      headers: { authorization: `Bearer ${options.internalServiceToken}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch (error) {
    throw new SourceUnavailableError(error instanceof Error ? error.message : String(error));
  }
  if (response.status === 404) return { status: 404, body: undefined };
  if (!response.ok) throw new SourceUnavailableError(`HTTP ${String(response.status)}`);
  return { status: response.status, body: await response.json() };
}

/**
 * Asks org-service where an org sits. Orgs never move (org-service's own
 * comment on the route), so an answer is kept for as long as the process runs;
 * "no such org" is asked again after a minute, since the org may be created
 * meanwhile. The cache is bounded.
 */
export function createLineageLookup(
  options: InternalClientOptions & { now?: () => number },
): LineageLookup {
  const now = options.now ?? Date.now;
  const known = new Map<string, OrgLineage>();
  const missing = new Map<string, number>();

  return async (orgId) => {
    const hit = known.get(orgId);
    if (hit !== undefined) return hit;
    const missUntil = missing.get(orgId);
    if (missUntil !== undefined && missUntil > now()) return undefined;

    const { status, body } = await internalGet(
      options,
      `/internal/v1/orgs/${encodeURIComponent(orgId)}/lineage`,
    );
    if (status === 404) {
      if (missing.size > 10_000) missing.clear();
      missing.set(orgId, now() + 60_000);
      return undefined;
    }
    const record = body as { type?: unknown; resellerId?: unknown };
    const type = record.type;
    if (type !== 'master' && type !== 'reseller' && type !== 'tenant') {
      throw new SourceUnavailableError('Unexpected lineage answer.');
    }
    const lineage: OrgLineage = {
      type,
      resellerId: typeof record.resellerId === 'string' ? record.resellerId : null,
    };
    if (known.size > 10_000) known.clear();
    known.set(orgId, lineage);
    return lineage;
  };
}

/**
 * S9-13: the tenant's queues as they are now, as call-control reads them from the nodes (counts
 * and statuses only; `GET /internal/v1/tenants/:t/queues`). Passed on as call-control gives them:
 * the hub only compares and forwards. Throws when call-control cannot be asked.
 */
export type LiveQueuesSource = (tenantId: string) => Promise<unknown[]>;

export function createLiveQueuesSource(options: InternalClientOptions): LiveQueuesSource {
  return async (tenantId) => {
    const { body } = await internalGet(
      options,
      `/internal/v1/tenants/${encodeURIComponent(tenantId)}/queues`,
    );
    const queues = (body as { queues?: unknown } | undefined)?.queues;
    if (!Array.isArray(queues)) throw new SourceUnavailableError('Unexpected queues answer.');
    return queues as unknown[];
  };
}

/** Asks call-control for the tenant's live calls (`GET /internal/v1/tenants/:t/calls`). */
export function createLiveCallsSource(options: InternalClientOptions): LiveCallsSource {
  return async (tenantId) => {
    const { body } = await internalGet(
      options,
      `/internal/v1/tenants/${encodeURIComponent(tenantId)}/calls`,
    );
    const calls = (body as { calls?: unknown } | undefined)?.calls;
    if (!Array.isArray(calls)) throw new SourceUnavailableError('Unexpected live calls answer.');
    return calls.flatMap((entry) => {
      const call = liveCallFromSnapshot(entry);
      return call === undefined ? [] : [call];
    });
  };
}

/**
 * S5-10 (G-122): every extension of the tenant with whether a phone is registered for it and
 * whether it is set to do not disturb (telephony-config's `GET /internal/v1/tenants/:t/presence`),
 * for the presence topic's snapshot. Throws when telephony-config cannot be asked.
 */
export type PresenceStatusSource = (tenantId: string) => Promise<ExtensionStatus[]>;

export function createPresenceStatusSource(options: InternalClientOptions): PresenceStatusSource {
  return async (tenantId) => {
    const { body } = await internalGet(
      options,
      `/internal/v1/tenants/${encodeURIComponent(tenantId)}/presence`,
    );
    const extensions = (body as { extensions?: unknown } | undefined)?.extensions;
    if (!Array.isArray(extensions)) throw new SourceUnavailableError('Unexpected presence answer.');
    return extensions.flatMap((entry) => {
      const status = extensionStatusOf(entry);
      return status === undefined ? [] : [status];
    });
  };
}

/** An extension's status from a snapshot entry or a `call.presence.changed` payload; undefined when malformed. */
export function extensionStatusOf(value: unknown): ExtensionStatus | undefined {
  const record = value as { extension?: unknown; registered?: unknown; dnd?: unknown } | null;
  if (typeof record !== 'object' || record === null) return undefined;
  const { extension, registered, dnd } = record;
  if (
    typeof extension !== 'string' ||
    typeof registered !== 'boolean' ||
    typeof dnd !== 'boolean'
  ) {
    return undefined;
  }
  return { extension, registered, dnd };
}

/**
 * S5-15: a person's own extension number (pbx-config-service's
 * `GET /internal/v1/tenants/:t/users/:u/extension`, the lookup every
 * self-service route uses), for the `user:{u}:calls` topic. Undefined when no
 * extension is linked to the person; throws when pbx-config-service cannot be
 * asked.
 */
export type UserExtensionSource = (tenantId: string, userId: string) => Promise<string | undefined>;

/**
 * Asks pbx-config-service, keeping each answer for `ttlMs` (default 30 s): a
 * console that reconnects, or several tabs, do not ask again each time, and a
 * relinked extension is seen within that time (the hub also checks again on
 * its periodic permission recheck). "None linked" is not kept, so linking one
 * shows at once. The cache is bounded.
 */
export function createUserExtensionSource(
  options: InternalClientOptions & { ttlMs?: number; now?: () => number },
): UserExtensionSource {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 30_000;
  const cache = new Map<string, { number: string; expires: number }>();
  return async (tenantId, userId) => {
    const key = `${tenantId}:${userId}`;
    const hit = cache.get(key);
    if (hit !== undefined && hit.expires > now()) return hit.number;
    const { status, body } = await internalGet(
      options,
      `/internal/v1/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/extension`,
    );
    if (status === 404) {
      cache.delete(key);
      return undefined;
    }
    const number = (body as { number?: unknown } | undefined)?.number;
    if (typeof number !== 'string' || number === '') {
      throw new SourceUnavailableError('Unexpected extension answer.');
    }
    if (cache.size > 10_000) cache.clear();
    cache.set(key, { number, expires: now() + ttlMs });
    return number;
  };
}

/**
 * G-119 (1): which live calls a person may monitor, for their `user:{u}:supervised` topic: every
 * call of the tenant when they hold `monitor.listen`, `whisper` or `barge` across it (a role such
 * as `tenant_supervisor`, or a grant on the org); otherwise the extensions and queues they are
 * granted any of those on, where a queue also covers its agents' extensions (pbx-config-service's
 * `POST /internal/v1/tenants/:t/monitor-scope`). Undefined when they may monitor nothing. Throws
 * when identity-service or pbx-config-service cannot be asked.
 */
export type SupervisionScopeSource = (
  tenantId: string,
  userId: string,
) => Promise<CallScope | undefined>;

const MONITORING: readonly Permission[] = ['monitor.listen', 'monitor.whisper', 'monitor.barge'];

export function createSupervisionScopeSource(
  options: InternalClientOptions & { readonly access: AccessClient },
): SupervisionScopeSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (tenantId, userId) => {
    let held: ActorAccess;
    try {
      held = await options.access.resolve({ orgId: tenantId, actorId: userId });
    } catch (error) {
      throw new SourceUnavailableError(error instanceof Error ? error.message : String(error));
    }
    const org = { id: tenantId, type: 'tenant' as const, resellerId: null };
    const actor = { id: userId, type: 'user' as const, org, roleIds: held.roles.map((r) => r.id) };
    const roles = new Map(
      held.roles.map((role) => [role.id, { id: role.id, permissions: new Set(role.permissions) }]),
    );
    const may = (permission: Permission, scope?: Scope) =>
      allowed({
        actor,
        permission,
        resource: scope === undefined ? { org } : { org, scope },
        roles,
        grants: held.grants,
      });
    if (MONITORING.some((permission) => may(permission))) {
      return { extensions: 'all', queues: new Set() };
    }

    const extensionIds = new Set<string>();
    const queueIds = new Set<string>();
    for (const grant of held.grants) {
      if (!MONITORING.includes(grant.permission)) continue;
      if (grant.scope.type !== 'extension' && grant.scope.type !== 'queue') continue;
      if (!may(grant.permission, grant.scope)) continue;
      (grant.scope.type === 'extension' ? extensionIds : queueIds).add(grant.scope.id);
    }
    if (extensionIds.size === 0 && queueIds.size === 0) return undefined;

    let response: Response;
    try {
      response = await fetchImpl(
        `${options.baseUrl.replace(/\/+$/, '')}/internal/v1/tenants/${encodeURIComponent(tenantId)}/monitor-scope`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.internalServiceToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ extensionIds: [...extensionIds], queueIds: [...queueIds] }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
        },
      );
    } catch (error) {
      throw new SourceUnavailableError(error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) throw new SourceUnavailableError(`HTTP ${String(response.status)}`);
    const body = (await response.json()) as { extensions?: unknown };
    if (!Array.isArray(body.extensions) || !body.extensions.every((n) => typeof n === 'string')) {
      throw new SourceUnavailableError('Unexpected monitor scope answer.');
    }
    return { extensions: new Set(body.extensions), queues: queueIds };
  };
}
