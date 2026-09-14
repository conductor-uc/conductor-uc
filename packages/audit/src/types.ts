import type { ActorType, DataClass } from '@cuc/authz';

export type { ActorType, DataClass };

/**
 * One `audit_events` row (05 §3.2, 07 §4): a write, a private/secret read, an
 * authentication event, or a monitoring action.
 *
 * `targetOrgId` is the org whose data or configuration the action concerns —
 * a tenant whose CDR a master read, the reseller a new tenant was created
 * under, and so on. It is optional because some actions genuinely have no
 * single target (a cross-tenant dashboard query through `unscoped(ctx,
 * reason)` is about many orgs at once, not one).
 */
export interface AuditEventInput {
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly actorOrgId: string;
  readonly targetOrgId?: string;
  /** A short, stable verb, e.g. `cdr.read`, `extension.updated`, `login.succeeded`. */
  readonly action: string;
  /** What was acted on, e.g. an id, a free-text description for a broad query. */
  readonly resource: string;
  readonly dataClass: DataClass;
  /** Free-text justification — mandatory for `unscoped(ctx, reason)` access, optional elsewhere. */
  readonly reason?: string;
  readonly ip?: string;
  readonly requestId?: string;
  /** Defaults to now. Set it when recording something that happened earlier. */
  readonly occurredAt?: Date;
}
