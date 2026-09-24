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
  return held == null || held.contains(permission);
});
