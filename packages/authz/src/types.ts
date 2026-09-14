/**
 * Data classes from 07 §3.2. The canonical definition lives here — `@cuc/http`
 * re-exports it rather than declaring its own, so a route's `dataClass` and
 * the authorization model are talking about the same four values by
 * construction, not by two packages happening to agree.
 */
export const DATA_CLASSES = ['config', 'private', 'usage', 'secret'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export function isDataClass(value: unknown): value is DataClass {
  return typeof value === 'string' && (DATA_CLASSES as readonly string[]).includes(value);
}

/** A permission from the catalog in 07 §3.3, e.g. `cdr.read`. */
export type Permission = string;

/** Which tier an org sits in (02 §1). */
export type OrgType = 'master' | 'reseller' | 'tenant';

/** Who is acting (07 §1). */
export type ActorType = 'user' | 'apikey' | 'service' | 'node';

/**
 * The org an actor or a resource belongs to, as far as the evaluator needs to
 * know: enough to compute ancestry (07 §3.1) without a database lookup.
 */
export interface OrgRef {
  readonly id: string;
  readonly type: OrgType;
  /** The owning reseller for a tenant; null for master and reseller orgs. */
  readonly resellerId: string | null;
}

export interface Actor {
  readonly id: string;
  readonly type: ActorType;
  readonly org: OrgRef;
  /** Every role assigned to this actor. Built-in and custom roles alike. */
  readonly roleIds: readonly string[];
}

/** Scopes from 07 §3.1. A grant with scope `org` covers everything in that org. */
export const SCOPE_TYPES = [
  'org',
  'extension',
  'extension_group',
  'queue',
  'mailbox',
  'did',
] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export interface Scope {
  readonly type: ScopeType;
  readonly id: string;
}

/** The thing a permission is being checked against. */
export interface ResourceRef {
  readonly org: OrgRef;
  /** The specific scope this resource occupies. Defaults to `org:{org.id}`. */
  readonly scope?: Scope;
}

/** A grant: one permission, on one scope, for one principal (07 §3.1). */
export interface Grant {
  readonly principalType: 'user' | 'role';
  readonly principalId: string;
  readonly permission: Permission;
  readonly scope: Scope;
}

/** A role: a name plus the permissions it bundles (07 §3.1). */
export interface Role {
  readonly id: string;
  readonly permissions: ReadonlySet<Permission>;
}

/** Role id to role, for however many roles apply to one evaluation. */
export type RoleCatalog = ReadonlyMap<string, Role>;
