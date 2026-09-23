import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/session.dart';
import '../pbx/pbx_api.dart';

/// The resellers under the master, or the tenants under a reseller.
class OrgsApi {
  OrgsApi(this._dio, this._token);

  final Dio _dio;
  final String _token;

  Future<List<Json>> _rows(String path) async {
    final response = await _dio.get<Object?>(
      path,
      options: Options(headers: {'Authorization': 'Bearer $_token'}),
    );
    final rows = (response.data as Map)['rows'] as List;
    return [for (final r in rows) (r as Map).cast<String, dynamic>()];
  }

  Future<List<Json>> resellers() => _rows('/v1/resellers');

  Future<List<Json>> tenantsOf(String resellerId) =>
      _rows('/v1/resellers/$resellerId/tenants');
}

final orgsApiProvider = Provider<OrgsApi?>((ref) {
  final session = ref.watch(sessionProvider);
  if (session == null) return null;
  return OrgsApi(ref.watch(apiProvider).dio, session.accessToken);
});

final resellersProvider = FutureProvider<List<Json>>((ref) async {
  return await ref.watch(orgsApiProvider)?.resellers() ?? const [];
});

/// Tenants of one reseller; a reseller user passes their own org id.
final tenantsProvider = FutureProvider.family<List<Json>, String>((
  ref,
  resellerId,
) async {
  return await ref.watch(orgsApiProvider)?.tenantsOf(resellerId) ?? const [];
});
