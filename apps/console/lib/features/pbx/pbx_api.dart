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
  return ref.watch(actingProvider)?.id;
});

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
