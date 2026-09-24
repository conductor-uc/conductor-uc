import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/acting.dart';
import '../../core/api_client.dart';
import '../../core/session.dart';

export '../../core/problem.dart' show problemMessage;

typedef Json = Map<String, dynamic>;

/// The tenant whose configuration is being edited: the signed-in tenant user's
/// own org, or the tenant a master or reseller user is acting as.
final tenantIdProvider = Provider<String?>((ref) {
  final session = ref.watch(sessionProvider);
  if (session == null) return null;
  if (session.orgType == OrgType.tenant) return session.orgId;
  return ref.watch(actingProvider)?.id ?? ref.watch(pickedTenantProvider);
});

/// A tenant chosen on a page that works on one tenant's records without
/// entering it (a reseller's Trunks page). Acting as a tenant takes
/// precedence; signing out clears it.
class PickedTenant extends Notifier<String?> {
  @override
  String? build() {
    ref.listen(sessionProvider, (_, session) {
      if (session == null) state = null;
    });
    return null;
  }

  void pick(String? id) => state = id;
}

final pickedTenantProvider = NotifierProvider<PickedTenant, String?>(
  PickedTenant.new,
);

/// JSON over the gateway for `/v1/tenants/{tenantId}/...`. Plain maps rather
/// than generated models: every resource here is edited through the same
/// field-driven form (see `resource.dart`).
class PbxApi {
  PbxApi(this._dio, this.tenantId, this._token);

  final Dio _dio;
  final String tenantId;
  final String _token;

  String _path(String resource, [String? id, String? action]) {
    final base = '/v1/tenants/$tenantId/$resource';
    return [base, ?id, ?action].join('/');
  }

  Options get _options => Options(headers: {'Authorization': 'Bearer $_token'});

  Future<List<Json>> list(String resource) async {
    final response = await _dio.get<Object?>(
      _path(resource),
      options: _options,
    );
    final rows = (response.data as Map)['rows'] as List;
    return [for (final r in rows) (r as Map).cast<String, dynamic>()];
  }

  Future<Json> get(String resource, String id) async {
    final response = await _dio.get<Object?>(
      _path(resource, id),
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  Future<Json> create(String resource, Json body) async {
    final response = await _dio.post<Object?>(
      _path(resource),
      data: body,
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  Future<Json> update(String resource, String id, Json body) async {
    final response = await _dio.patch<Object?>(
      _path(resource, id),
      data: body,
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  Future<void> delete(String resource, String id) async {
    await _dio.delete<Object?>(_path(resource, id), options: _options);
  }

  /// Where a phone registers: the server, port, transports and realm for this
  /// tenant (`GET /v1/tenants/{id}/sip-endpoint`).
  Future<Json> sipEndpoint() async {
    final response = await _dio.get<Object?>(
      _path('sip-endpoint'),
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  /// An extension's SIP username, password and realm. The password is not kept
  /// anywhere else; each reveal is audited with [reason].
  Future<Json> revealSip(String extensionId, String reason) async {
    final response = await _dio.post<Object?>(
      _path('extensions', extensionId, 'reveal'),
      data: {'reason': reason},
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  /// Gives an extension a new SIP password and returns it (once). The old one
  /// stops working; the change is audited with [reason].
  Future<Json> resetSipPassword(String extensionId, String reason) async {
    final response = await _dio.post<Object?>(
      _path('extensions', extensionId, 'reset-password'),
      data: {'reason': reason},
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  /// The address, user name and password a desk phone is given to fetch its
  /// settings. The password is shown once; asking again replaces it.
  Future<Json> issueProvisioning(String deviceId, String reason) async {
    final response = await _dio.post<Object?>(
      _path('devices', deviceId, 'provisioning-credentials'),
      data: {'reason': reason},
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  /// An extension's call handling: do not disturb, forwarding and simultaneous
  /// ring (`GET .../extensions/{id}/call-handling`). Never 404s for an existing
  /// extension: nothing configured reads as everything off.
  Future<Json> callHandling(String extensionId) async {
    final response = await _dio.get<Object?>(
      _path('extensions', extensionId, 'call-handling'),
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  /// Replaces an extension's call handling (`PUT`); the service checks the
  /// numbers and destinations and answers 400 with what is wrong.
  Future<Json> saveCallHandling(String extensionId, Json body) async {
    final response = await _dio.put<Object?>(
      _path('extensions', extensionId, 'call-handling'),
      data: body,
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  /// A call to an action or sub-resource, such as `flows/{id}/publish`.
  Future<Object?> call(
    String method,
    String resource,
    String id,
    String? action, {
    Object? body,
  }) async {
    final response = await _dio.request<Object?>(
      _path(resource, id, action),
      data: body,
      options: Options(
        method: method,
        headers: {'Authorization': 'Bearer $_token'},
      ),
    );
    return response.data;
  }
}

final pbxApiProvider = Provider<PbxApi?>((ref) {
  final tenant = ref.watch(tenantIdProvider);
  final session = ref.watch(sessionProvider);
  if (tenant == null || session == null) return null;
  return PbxApi(ref.watch(apiProvider).dio, tenant, session.accessToken);
});

/// The rows of one resource. Invalidate it after a change.
final rowsProvider = FutureProvider.family<List<Json>, String>((
  ref,
  resource,
) async {
  final api = ref.watch(pbxApiProvider);
  if (api == null) return const [];
  return api.list(resource);
});
