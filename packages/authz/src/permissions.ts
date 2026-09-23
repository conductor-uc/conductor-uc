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
 */
export const PERMISSION_CATALOG: Readonly<Record<Permission, DataClass>> = {
  'reseller.create': 'config',
  'reseller.manage': 'config',
  'tenant.create': 'config',
  'tenant.manage': 'config',
  'tenant.suspend': 'config',
  'domain.manage': 'config',
  'brand.manage': 'config',
  'user.manage': 'config',
  'role.manage': 'config',
  'grant.manage': 'config',
  'extension.manage': 'config',
  'did.manage': 'config',
  'emergency_location.manage': 'config',
  'emergency_route.manage': 'config',
  'group.manage': 'config',
  'queue.manage': 'config',
  'parking_lot.manage': 'config',
  'conference_room.manage': 'config',
  'schedule.manage': 'config',
  'media.manage': 'config',
  'trunk.manage': 'config',
  'callflow.edit': 'config',
  'callflow.publish': 'config',
  'secret.reveal': 'secret',
  'recording.policy.manage': 'config',
  'recording.listen': 'private',
  'recording.download': 'private',
  'recording.delete': 'private',
  'cdr.read': 'private',
  'cdr.export': 'private',
  'billing.read': 'usage',
  'voicemail.access': 'private',
  'monitor.presence': 'config',
  'monitor.listen': 'private',
  'monitor.whisper': 'private',
  'monitor.barge': 'private',
  'analytics.view': 'private',
  'audit.read': 'private',
  'apikey.manage': 'secret',
};

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
