import { allPermissions } from './permissions.js';
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

const RESELLER_ADMIN_PERMISSIONS: readonly Permission[] = [
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
  'group.manage',
  'queue.manage',
  'schedule.manage',
  'media.manage',
  'trunk.manage',
  'audit.read',
  'apikey.manage',
];

const TENANT_ADMIN_PERMISSIONS: readonly Permission[] = [
  'user.manage',
  'role.manage',
  'grant.manage',
  'extension.manage',
  'did.manage',
  'group.manage',
  'queue.manage',
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
];

/**
 * "Read everything, no writes" (master_support) and "read config"
 * (reseller_support) describe a read/write split the catalog in 07 §3.3 does
 * not actually carry: every entry there is a management permission
 * (`*.manage`, `*.edit`, …) or one of the small set of genuinely read-shaped
 * ones (`cdr.read`, `analytics.view`, `audit.read`, `monitor.presence`).
 * There is no `tenant.read` or `extension.read` to give a support role, so a
 * support user cannot yet read tenant or extension *records* through a
 * permission — only the operational, read-shaped surfaces the catalog
 * defines. This is a real gap in the initial catalog, not a modeling choice;
 * closing it means adding read counterparts to the `*.manage` permissions,
 * which is a decisions.md-worthy change to 07 §3.3, not something to invent
 * unilaterally here.
 */
const READ_SHAPED_PERMISSIONS: readonly Permission[] = [
  'cdr.read',
  'analytics.view',
  'audit.read',
  'monitor.presence',
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
  ['master_support', role('master_support', READ_SHAPED_PERMISSIONS)],
  ['reseller_admin', role('reseller_admin', RESELLER_ADMIN_PERMISSIONS)],
  ['reseller_support', role('reseller_support', ['audit.read'])],
  ['tenant_admin', role('tenant_admin', TENANT_ADMIN_PERMISSIONS)],
  [
    'tenant_supervisor',
    role('tenant_supervisor', [
      'monitor.presence',
      'monitor.listen',
      'monitor.whisper',
      'monitor.barge',
      'analytics.view',
    ]),
  ],
  // Voicemail and recording access for one's own extension/mailbox are
  // per-scope grants (05 §3.2's "own extension, voicemail, and recordings
  // where granted"), not a role permission — a role has no scope of its own,
  // so bundling voicemail.access here would give every tenant user access to
  // every mailbox in the org, not just their own.
  ['tenant_user', role('tenant_user', ['monitor.presence'])],
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
