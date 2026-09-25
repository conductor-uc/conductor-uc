import type { DataClass, Permission } from './types.js';

/**
 * The permission catalog (07 §3.3), as data: every permission this codebase
 * currently defines, mapped to its data class. `@cuc/http`'s route-contract
 * guard requires a `dataClass` on every route (CLAUDE.md rule 3); this is
 * where that value comes from, not a string a route author picks by hand.
 *
 * `audit.read` is documented as `config/private` — a route serving audit data
 * that includes private entries declares `private`, one that only ever serves
 * config-class audit entries declares `config`. There is no single right
 * answer for it here, so it is listed under `private`, the stricter reading:
 * a route can decide to be more permissive by declaring `config` for a
 * genuinely config-only audit slice, but nothing here should default a
 * caller into an insufficiently strict class.
 *
 * `domain.manage` is not in 07 §3.3 — S1-03 needed a permission for reseller
 * base-domain registration and verification, and 02 §3 describes domains as
 * reseller/org configuration, so it is added here the same shape as every
 * other `*.manage` permission rather than left ungated.
 *
 * `parking_lot.manage` is not in 07 §3.3 either, same story — S2-14 needed
 * one for parking-lot config and none of the catalog's existing resource
 * permissions (`queue.manage` et al.) name it, so it is added here rather
 * than overloaded onto a semantically different resource's permission.
 *
 * `conference_room.manage` is the same story again — S2-15.
 *
 * `billing.read` is not in 07 §3.3's own initial catalog either: it is the
 * new permission C-1/D-013 (issue #95, resolved 2026-09-15) calls for — a
 * `usage`-class billing record distinct from a full, `private`-class CDR,
 * so a reseller can read it without H1 blocking them the way `cdr.read`
 * already does (docs/decisions.md's C-1 entry has the full resolution).
 *
 * Every configuration management permission has a `.read` twin
 * (`extension.read` for `extension.manage`, `callflow.read` for
 * `callflow.edit`/`callflow.publish`, …), with the same data class (G-10,
 * S1-15). List and view routes declare the twin, writes keep the management
 * permission, and holding the management permission implies the twin (see
 * {@link READ_TWINS}), so a role or grant that only names `.manage` still
 * reads. The secret-class permissions (`secret.reveal`, `apikey.manage`) have
 * no twin: there is nothing to read about a secret short of revealing it.
 */
/**
 * `org.view` is not in 07 §3.3 either: S3-02 needs a permission for "read the
 * brand my own org is presented with" (the console re-themes after login), and
 * every signed-in actor needs it, so every built-in role carries it. It reads
 * no tenant records; it is `config` only because the catalog has no lower class.
 */
export const PERMISSION_CATALOG: Readonly<Record<Permission, DataClass>> = {
  'org.view': 'config',
  'reseller.create': 'config',
  'reseller.manage': 'config',
  'reseller.read': 'config',
  'tenant.create': 'config',
  'tenant.manage': 'config',
  'tenant.read': 'config',
  'tenant.suspend': 'config',
  'domain.manage': 'config',
  'domain.read': 'config',
  'brand.manage': 'config',
  'brand.read': 'config',
  'user.manage': 'config',
  'user.read': 'config',
  'role.manage': 'config',
  'role.read': 'config',
  'grant.manage': 'config',
  'grant.read': 'config',
  'extension.manage': 'config',
  'extension.read': 'config',
  'did.manage': 'config',
  'did.read': 'config',
  'emergency_location.manage': 'config',
  'emergency_location.read': 'config',
  'emergency_route.manage': 'config',
  'emergency_route.read': 'config',
  'group.manage': 'config',
  'group.read': 'config',
  'queue.manage': 'config',
  'queue.read': 'config',
  'parking_lot.manage': 'config',
  'parking_lot.read': 'config',
  'conference_room.manage': 'config',
  'conference_room.read': 'config',
  'schedule.manage': 'config',
  'schedule.read': 'config',
  'media.manage': 'config',
  'media.read': 'config',
  'trunk.manage': 'config',
  'trunk.read': 'config',
  'callflow.read': 'config',
  'callflow.edit': 'config',
  'callflow.publish': 'config',
  'secret.reveal': 'secret',
  'recording.policy.manage': 'config',
  'recording.policy.read': 'config',
  'recording.listen': 'private',
  'recording.download': 'private',
  'recording.delete': 'private',
  'cdr.read': 'private',
  'cdr.export': 'private',
  'billing.read': 'usage',
  'voicemail.access': 'private',
  'monitor.presence': 'config',
  'monitor.calls': 'private',
  'monitor.listen': 'private',
  'monitor.whisper': 'private',
  'monitor.barge': 'private',
  'analytics.view': 'private',
  'audit.read': 'private',
  'apikey.manage': 'secret',
  'self.settings': 'config',
  'self.voicemail': 'private',
  'self.history': 'private',
};

/**
 * `monitor.calls` is not in 07 §3.3's initial catalog either: S5-08's realtime
 * hub needs a permission for "watch the tenant's live calls" (the
 * `tenant:{t}:calls` topic: parties' numbers, state, duration, recording
 * state). 07 §3.2 classes live call monitoring as `private`, so none of the
 * config-class permissions fit (`monitor.presence` is held by every tenant
 * user), and the private ones each mean something else: `monitor.listen`/
 * `whisper`/`barge` act on a call and are not held by tenant admins,
 * `cdr.read` is call history and not held by supervisors, and
 * `analytics.view` is reports and wallboards. It is `private`, so H1 keeps
 * every reseller out, and like every private permission it has no read twin
 * and nothing implies it (docs/decisions.md G-119).
 */
/**
 * `self.settings`, `self.voicemail` and `self.history` are not in 07 §3.3
 * either: they are the end-user self-service portal's (parity 1e) permissions
 * for a person's OWN extension, mailbox and call history. They are a different
 * shape from every other permission here: a service that honours one never
 * takes the extension from the request. It resolves it from the signed actor
 * id (the extension whose `user_id` is that actor), so holding a `self.*`
 * permission can never reach anyone else's data. `self.voicemail` and
 * `self.history` are `private` (voicemail and call history), so H1 keeps every
 * reseller out of them; `self.settings` is `config`.
 */
export const SELF_PERMISSIONS = ['self.settings', 'self.voicemail', 'self.history'] as const;

export type CatalogPermission = keyof typeof PERMISSION_CATALOG;

export class UnknownPermissionError extends Error {
  override readonly name = 'UnknownPermissionError';

  constructor(permission: string) {
    super(
      `'${permission}' is not in the permission catalog. Add it to PERMISSION_CATALOG ` +
        '(07 §3.3) before a route or a role references it.',
    );
  }
}

/** The data class a permission implies. Throws for anything not in the catalog. */
export function dataClassOf(permission: Permission): DataClass {
  const dataClass = PERMISSION_CATALOG[permission];
  if (dataClass === undefined) throw new UnknownPermissionError(permission);
  return dataClass;
}

/** True when `permission` is in the catalog. */
export function isKnownPermission(permission: string): boolean {
  return Object.hasOwn(PERMISSION_CATALOG, permission);
}

/** Every permission in the catalog. */
export function allPermissions(): readonly Permission[] {
  return Object.keys(PERMISSION_CATALOG);
}

/**
 * The read twin of each configuration management permission (G-10): holding
 * the key implies holding the value. This is the one place the implication is
 * defined; everything that answers "does this person hold X" goes through
 * {@link implies}, {@link grantingPermissions} or {@link expandPermissions}
 * (`roleHas`/`grantMatches` here, identity-service's permission lookup and
 * `/me`, `@cuc/http`'s permission resolver), so a custom role that names only
 * `extension.manage` keeps reading extensions without being re-granted.
 *
 * Only `.manage` → `.read` (and the two call-flow verbs → `callflow.read`).
 * Nothing else implies anything: `tenant.create` or `tenant.suspend` alone do
 * not read tenants, and no permission implies a `private` one.
 */
export const READ_TWINS: Readonly<Record<Permission, Permission>> = {
  'reseller.manage': 'reseller.read',
  'tenant.manage': 'tenant.read',
  'domain.manage': 'domain.read',
  'brand.manage': 'brand.read',
  'user.manage': 'user.read',
  'role.manage': 'role.read',
  'grant.manage': 'grant.read',
  'extension.manage': 'extension.read',
  'did.manage': 'did.read',
  'emergency_location.manage': 'emergency_location.read',
  'emergency_route.manage': 'emergency_route.read',
  'group.manage': 'group.read',
  'queue.manage': 'queue.read',
  'parking_lot.manage': 'parking_lot.read',
  'conference_room.manage': 'conference_room.read',
  'schedule.manage': 'schedule.read',
  'media.manage': 'media.read',
  'trunk.manage': 'trunk.read',
  'callflow.edit': 'callflow.read',
  'callflow.publish': 'callflow.read',
  'recording.policy.manage': 'recording.policy.read',
};

/** Every configuration read permission (the values of {@link READ_TWINS}), in catalog order. */
export const CONFIG_READ_PERMISSIONS: readonly Permission[] = allPermissions().filter((p) =>
  Object.values(READ_TWINS).includes(p),
);

/** True when holding `held` gives `wanted`: the same permission, or its read twin. */
export function implies(held: Permission, wanted: Permission): boolean {
  return held === wanted || (Object.hasOwn(READ_TWINS, held) && READ_TWINS[held] === wanted);
}

/**
 * Every permission whose holder holds `wanted`: `wanted` itself, plus the
 * management permissions whose read twin it is. `extension.read` →
 * `['extension.read', 'extension.manage']`.
 */
export function grantingPermissions(wanted: Permission): readonly Permission[] {
  return [
    wanted,
    ...Object.entries(READ_TWINS)
      .filter(([, read]) => read === wanted)
      .map(([manage]) => manage),
  ];
}

/**
 * `held` plus everything it implies, as one flat set: what a person holds for
 * any check that is a plain set lookup (the http permission guard, the
 * console's `/me`).
 */
export function expandPermissions(held: Iterable<Permission>): Set<Permission> {
  const out = new Set<Permission>();
  for (const permission of held) {
    out.add(permission);
    if (Object.hasOwn(READ_TWINS, permission)) out.add(READ_TWINS[permission] as Permission);
  }
  return out;
}

/** True when a flat set of held permissions gives `wanted`, directly or by implication. */
export function holdsPermission(held: ReadonlySet<Permission>, wanted: Permission): boolean {
  return grantingPermissions(wanted).some((permission) => held.has(permission));
}
