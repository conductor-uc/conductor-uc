import {
  allPermissions,
  CONFIG_READ_PERMISSIONS,
  READ_TWINS,
  SELF_PERMISSIONS,
} from './permissions.js';
import type { Permission, Role, RoleCatalog } from './types.js';

/**
 * Built-in role ids (07 §3.3). Custom roles are per org and are never one of
 * these ids — `role_id` for a custom role is a generated one, so there is no
 * namespace collision to guard against.
 */
export const BUILT_IN_ROLE_IDS = [
  'master_admin',
  'master_support',
  'reseller_admin',
  'reseller_support',
  'tenant_admin',
  'tenant_supervisor',
  'tenant_user',
] as const;
export type BuiltInRoleId = (typeof BUILT_IN_ROLE_IDS)[number];

function role(id: BuiltInRoleId, permissions: readonly Permission[]): Role {
  return { id, permissions: new Set(permissions) };
}

/**
 * The admin roles list management permissions only. Each one implies its
 * `.read` twin wherever permissions are evaluated (`READ_TWINS`, G-10), so an
 * admin reads everything it manages without the reads being listed here.
 */
const RESELLER_ADMIN_PERMISSIONS: readonly Permission[] = [
  'org.view',
  'tenant.create',
  'tenant.manage',
  'tenant.suspend',
  'domain.manage',
  'brand.manage',
  'user.manage',
  'role.manage',
  'grant.manage',
  'extension.manage',
  'did.manage',
  'emergency_location.manage',
  'emergency_route.manage',
  'group.manage',
  'queue.manage',
  'parking_lot.manage',
  'conference_room.manage',
  'schedule.manage',
  'media.manage',
  'trunk.manage',
  'audit.read',
  'apikey.manage',
  'billing.read',
];

const TENANT_ADMIN_PERMISSIONS: readonly Permission[] = [
  'org.view',
  'user.manage',
  'role.manage',
  'grant.manage',
  'extension.manage',
  'did.manage',
  'emergency_location.manage',
  'emergency_route.manage',
  'group.manage',
  'queue.manage',
  'parking_lot.manage',
  'conference_room.manage',
  'schedule.manage',
  'media.manage',
  'trunk.manage',
  'callflow.edit',
  'callflow.publish',
  'secret.reveal',
  'recording.policy.manage',
  'recording.listen',
  'recording.download',
  'recording.delete',
  'cdr.read',
  'cdr.export',
  'voicemail.access',
  'monitor.presence',
  'analytics.view',
  'audit.read',
  'apikey.manage',
  ...SELF_PERMISSIONS,
];

/**
 * "Read everything, no writes" (master_support) and "read config"
 * (reseller_support), in the catalog's terms (G-10, S1-15). Every
 * configuration management permission has a `.read` twin, and the list and
 * view routes declare the twin, so a support role holds reads and nothing a
 * write route asks for.
 *
 * `master_support` holds every configuration read, plus the read-shaped
 * operational and private surfaces it always had (`cdr.read`,
 * `analytics.view`, `audit.read`, `monitor.presence`) and the usage-class
 * `billing.read`. Its private reads are audited like every master access to
 * private data (SAD §10).
 *
 * `reseller_support` holds the reads of exactly what `reseller_admin` manages:
 * a support person never sees more than their own tier's admin could. That
 * leaves out `reseller.read` (H3 reserves it to the master), and the tenant-only
 * `callflow.read` and `recording.policy.read`, which no reseller role manages
 * either. H1 keeps it out of private data whatever it holds.
 */
const MASTER_SUPPORT_PERMISSIONS: readonly Permission[] = [
  'org.view',
  'cdr.read',
  'analytics.view',
  'audit.read',
  'monitor.presence',
  'billing.read',
  ...CONFIG_READ_PERMISSIONS,
];

const RESELLER_SUPPORT_PERMISSIONS: readonly Permission[] = [
  'org.view',
  'audit.read',
  ...RESELLER_ADMIN_PERMISSIONS.flatMap((permission) =>
    Object.hasOwn(READ_TWINS, permission) ? [READ_TWINS[permission] as Permission] : [],
  ),
];

/**
 * A supervisor watches queues and the people answering them, so it reads the
 * queue configuration (queues, agents and tiers are all `queue.read`) and the
 * extension directory the agents and monitored calls refer to. It changes
 * neither: that stays with `tenant_admin`.
 */
const TENANT_SUPERVISOR_PERMISSIONS: readonly Permission[] = [
  'org.view',
  'queue.read',
  'extension.read',
  'monitor.presence',
  'monitor.listen',
  'monitor.whisper',
  'monitor.barge',
  'analytics.view',
  ...SELF_PERMISSIONS,
];

/**
 * Built-in roles (07 §3.3), as permission bundles.
 *
 * `monitor.listen`/`monitor.whisper`/`monitor.barge` are bundled into
 * `tenant_supervisor` at the role level, which — per the ancestry rule — grants
 * them anywhere in the supervisor's own org. The doc's "scoped to target
 * extensions or queues" is a *finer* restriction than org-level ancestry
 * expresses: `call-control` is explicitly named as evaluating that finer
 * check "against the live call record in Redis" (07 §3.3), so the role gates
 * whether a supervisor can attempt a barge at all, and call-control gates
 * whether *this* barge, on *this* call, is one they supervise.
 */
export const BUILT_IN_ROLES: ReadonlyMap<BuiltInRoleId, Role> = new Map([
  ['master_admin', role('master_admin', allPermissions())],
  ['master_support', role('master_support', MASTER_SUPPORT_PERMISSIONS)],
  ['reseller_admin', role('reseller_admin', RESELLER_ADMIN_PERMISSIONS)],
  ['reseller_support', role('reseller_support', RESELLER_SUPPORT_PERMISSIONS)],
  ['tenant_admin', role('tenant_admin', TENANT_ADMIN_PERMISSIONS)],
  ['tenant_supervisor', role('tenant_supervisor', TENANT_SUPERVISOR_PERMISSIONS)],
  // Voicemail and recording access for one's own extension/mailbox used to be
  // a per-scope grant (05 §3.2's "own extension, voicemail, and recordings
  // where granted"), and `voicemail.access` still is: a role has no scope of
  // its own, so bundling it here would give every tenant user every mailbox in
  // the org. Self-service (parity 1e) is the scope-free answer: the `self.*`
  // permissions carry no resource, and the services that honour them resolve
  // the extension from the signed actor id, so they can only ever reach the
  // caller's own. `tenant_user` holds nothing but these and the two every
  // signed-in person needs.
  ['tenant_user', role('tenant_user', ['org.view', 'monitor.presence', ...SELF_PERMISSIONS])],
]);

export function isBuiltInRoleId(value: string): value is BuiltInRoleId {
  return (BUILT_IN_ROLE_IDS as readonly string[]).includes(value);
}

/** Merges the built-ins with an org's custom roles into one lookup. */
export function roleCatalog(customRoles: readonly Role[] = []): RoleCatalog {
  const merged = new Map<string, Role>(BUILT_IN_ROLES);
  for (const custom of customRoles) merged.set(custom.id, custom);
  return merged;
}
