import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/session.dart';

typedef Json = Map<String, dynamic>;

/// The tenant whose configuration is being edited. For now that is the signed-in
/// tenant user's own org; master and reseller users choose one with
/// act-as-descendant (S3-05).
final tenantIdProvider = Provider<String?>((ref) {
  final session = ref.watch(sessionProvider);
  return session?.orgType == OrgType.tenant ? session!.orgId : null;
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

/// The message to show for a failed call: the server's own `detail` (RFC 9457)
/// when it sent one, so "extension number already in use" reads as that.
String problemMessage(Object error) {
  if (error is DioException) {
    final data = error.response?.data;
    if (data is Map) {
      final detail = data['detail'] ?? data['title'] ?? data['message'];
      if (detail is String && detail.isNotEmpty) return detail;
    }
    if (error.response == null) return 'Could not reach the server.';
    return 'The server rejected that (${error.response!.statusCode}).';
  }
  return 'Something went wrong.';
}
