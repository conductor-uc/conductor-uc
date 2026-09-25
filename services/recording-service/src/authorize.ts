import {
  allowed,
  type Actor,
  type Grant,
  type OrgRef,
  type Permission,
  type Role,
  type Scope,
} from '@cuc/authz';
import type { AuditEventInput } from '@cuc/audit';
import { ProblemError, type RequestContext } from '@cuc/http';

import { AccessUnavailableError, type AccessClient, type ActorAccess } from './access.js';

/**
 * Who is asking and what they may do (07 §3.1), evaluated per request. Recordings are the
 * first data in this codebase where a *scoped* grant has to be honoured (G-91): a
 * supervisor holding `recording.listen` on `queue:Q1` hears Q1's calls and no others.
 */
export interface Caller {
  readonly actor: Actor;
  readonly access: ActorAccess;
  readonly tenantId: string;
  readonly requestId: string;
  readonly ip: string;
}

/** What a recording (or a policy) is attached to, for scope matching. */
export interface RecordingScopes {
  readonly extensionId: string | null;
  readonly peerExtensionId: string | null;
  readonly queueId: string | null;
  readonly didId: string | null;
}

/** The visible slice of a tenant's recordings for one caller. */
export type Visibility =
  { readonly kind: 'all' } | { readonly kind: 'scoped'; readonly scopes: readonly Scope[] };

export async function resolveCaller(
  context: RequestContext,
  tenantId: string,
  ip: string,
  access: AccessClient,
): Promise<Caller> {
  const { actorId, orgId, orgType } = context;
  if (actorId === undefined || orgId === undefined || orgType === undefined) {
    throw ProblemError.unauthorized('Sign in to continue.');
  }
  let resolved: ActorAccess;
  try {
    resolved = await access.resolve({ orgId, actorId });
  } catch (error) {
    if (error instanceof AccessUnavailableError) {
      throw new ProblemError(
        503,
        '/problems/unavailable',
        'Service unavailable',
        'permissions_unavailable',
        { detail: 'Permissions could not be checked; nothing was done. Try again shortly.' },
      );
    }
    throw error;
  }

  const org: OrgRef = { id: orgId, type: orgType, resellerId: context.resellerId ?? null };
  return {
    actor: {
      id: actorId,
      type: context.actorType ?? 'user',
      org,
      roleIds: resolved.roles.map((r) => r.id),
    },
    access: resolved,
    tenantId,
    requestId: context.requestId,
    ip,
  };
}

function roleCatalogOf(access: ActorAccess): Map<string, Role> {
  return new Map(
    access.roles.map((role) => [role.id, { id: role.id, permissions: new Set(role.permissions) }]),
  );
}

function tenantOrg(tenantId: string): OrgRef {
  // A tenant's owning reseller is not needed: resellers are turned away by H1 before this.
  return { id: tenantId, type: 'tenant', resellerId: null };
}

/** Whether `permission` holds across the tenant as a whole (a role, or a grant on the org). */
export function canForTenant(caller: Caller, permission: Permission): boolean {
  return allowed({
    actor: caller.actor,
    permission,
    resource: { org: tenantOrg(caller.tenantId) },
    roles: roleCatalogOf(caller.access),
    grants: caller.access.grants,
  });
}

/** Whether `permission` holds for one recording, through the tenant or any scope it sits in. */
export function canForRecording(
  caller: Caller,
  permission: Permission,
  scopes: RecordingScopes,
): boolean {
  if (canForTenant(caller, permission)) return true;
  const roles = roleCatalogOf(caller.access);
  return scopesOf(scopes).some((scope) =>
    allowed({
      actor: caller.actor,
      permission,
      resource: { org: tenantOrg(caller.tenantId), scope },
      roles,
      grants: caller.access.grants,
    }),
  );
}

function scopesOf(scopes: RecordingScopes): Scope[] {
  const out: Scope[] = [];
  if (scopes.extensionId !== null) out.push({ type: 'extension', id: scopes.extensionId });
  if (scopes.peerExtensionId !== null) out.push({ type: 'extension', id: scopes.peerExtensionId });
  if (scopes.queueId !== null) out.push({ type: 'queue', id: scopes.queueId });
  if (scopes.didId !== null) out.push({ type: 'did', id: scopes.didId });
  return out;
}

/**
 * Which recordings the caller may see in a list: all of the tenant's, or only those inside
 * the extension, queue and DID scopes they hold any of `permissions` on, or none (`undefined`).
 * Grants on scopes this service cannot resolve (an extension group, a mailbox) are not
 * expanded, so they widen nothing here.
 */
export function visibilityFor(
  caller: Caller,
  permissions: readonly Permission[],
): Visibility | undefined {
  if (permissions.some((permission) => canForTenant(caller, permission))) return { kind: 'all' };

  const scopes = new Map<string, Scope>();
  const roles = roleCatalogOf(caller.access);
  for (const grant of caller.access.grants) {
    if (!permissions.includes(grant.permission)) continue;
    if (
      grant.scope.type !== 'extension' &&
      grant.scope.type !== 'queue' &&
      grant.scope.type !== 'did'
    ) {
      continue;
    }
    const granted = allowed({
      actor: caller.actor,
      permission: grant.permission,
      resource: { org: tenantOrg(caller.tenantId), scope: grant.scope },
      roles,
      grants: caller.access.grants,
    });
    if (granted) scopes.set(`${grant.scope.type}:${grant.scope.id}`, grant.scope);
  }
  return scopes.size === 0 ? undefined : { kind: 'scoped', scopes: [...scopes.values()] };
}

export function forbidden(permission: Permission): ProblemError {
  return ProblemError.forbidden(`You do not have the ${permission} permission for this.`, {
    code: 'insufficient_permission',
  });
}

/** Throws 403 unless the caller holds `permission` across the tenant. */
export function requireForTenant(caller: Caller, permission: Permission): void {
  if (!canForTenant(caller, permission)) throw forbidden(permission);
}

export type AuditSink = (input: AuditEventInput) => Promise<void>;

/** The audit event for something the caller did (07 §4). */
export function auditFor(
  caller: Caller,
  input: {
    readonly action: string;
    readonly resource: string;
    readonly dataClass: 'private' | 'config';
  },
): AuditEventInput {
  return {
    actorType: caller.actor.type,
    actorId: caller.actor.id,
    actorOrgId: caller.actor.org.id,
    targetOrgId: caller.tenantId,
    action: input.action,
    resource: input.resource,
    dataClass: input.dataClass,
    ip: caller.ip,
    requestId: caller.requestId,
  };
}

export type { Grant };
