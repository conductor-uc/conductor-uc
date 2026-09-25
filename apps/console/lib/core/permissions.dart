import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api_client.dart';
import 'session.dart';

/// What the signed-in user can do: every permission they hold through any role
/// or grant, from `GET /v1/orgs/{orgId}/me` (access tokens carry none, G-56).
///
/// It decides what the console *shows*. The service that owns a resource still
/// decides whether a request is allowed (H1 and the other hard rules are also
/// enforced there).
///
/// Null while the answer is on its way, and when it could not be had (the
/// service is down, or the user's role lacks `org.view`): the console then
/// falls back to showing what the org type gets, rather than an empty shell.
final permissionsProvider = FutureProvider<Set<String>?>((ref) async {
  final session = ref.watch(sessionProvider);
  if (session == null) return null;
  try {
    final response = await ref
        .watch(apiProvider)
        .dio
        .get<Object?>(
          '/v1/orgs/${session.orgId}/me',
          options: Options(
            headers: {'Authorization': 'Bearer ${session.accessToken}'},
          ),
        );
    final body = response.data as Map;
    return {...(body['permissions'] as List).cast<String>()};
  } catch (_) {
    return null;
  }
});

/// The permissions once known, or null.
final knownPermissionsProvider = Provider<Set<String>?>(
  (ref) => ref.watch(permissionsProvider).value,
);

/// Whether the user holds [permission]. True while that is unknown, so a slow
/// or failed lookup never hides anything the server would have allowed.
final canProvider = Provider.family<bool, String?>((ref, permission) {
  if (permission == null) return true;
  final held = ref.watch(knownPermissionsProvider);
  return held == null || holds(held, permission);
});

/// The read twin of each configuration management permission (decision G-10):
/// holding the key implies holding the value. The same table as `READ_TWINS`
/// in `@cuc/authz` (a test keeps the two in step). `/me` already lists the
/// implied reads; applying the rule here as well keeps the console agreeing
/// with the services whatever it is told.
///
/// A screen needs the `.read` permission to be shown and the `.manage` one
/// (for call flows, `callflow.edit`/`callflow.publish`) for its create, edit
/// and delete actions, so a person holding only the read sees it read-only.
const readTwins = {
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

/// Whether [held] gives [permission]: it is held, or a management permission
/// whose read twin it is is held.
bool holds(Set<String> held, String permission) =>
    held.contains(permission) ||
    readTwins.entries.any((e) => e.value == permission && held.contains(e.key));

/// What the built-in `tenant_user` role holds (`@cuc/authz`): the permissions
/// that concern nothing but the person's own phone, and the two every signed-in
/// person has.
const selfScopedPermissions = {
  'org.view',
  'monitor.presence',
  'self.settings',
  'self.voicemail',
  'self.history',
};

/// Whether [held] is a person with a phone and nothing else: some `self.*`
/// permission and nothing beyond [selfScopedPermissions]. That person is shown
/// the "My phone" experience instead of the administrator's navigation. Null
/// (not known yet, or the lookup failed) is not self-only: the console then
/// shows what the org type gets, as it always did. Hiding is a convenience; the
/// services refuse an administrator's route to such a person regardless.
bool isSelfOnly(Set<String>? held) =>
    held != null &&
    held.any((p) => p.startsWith('self.')) &&
    held.every(selfScopedPermissions.contains);
