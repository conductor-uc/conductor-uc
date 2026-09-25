import 'dart:typed_data';

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

  Options get _options => Options(headers: {'Authorization': 'Bearer $_token'});

  Future<Json> _body(Future<Response<Object?>> call) async =>
      ((await call).data as Map).cast<String, dynamic>();

  /// The brand this session's org is presented with (S3-02).
  Future<Json> sessionBrand() =>
      _body(_dio.get<Object?>('/v1/session/brand', options: _options));

  Future<List<Json>> resellers() => _rows('/v1/resellers');

  Future<List<Json>> tenantsOf(String resellerId) =>
      _rows('/v1/resellers/$resellerId/tenants');

  /// A reseller (under the master), or a tenant under [resellerId].
  Future<Json> create({String? resellerId, required Json body}) => _body(
    _dio.post<Object?>(
      resellerId == null
          ? '/v1/resellers'
          : '/v1/resellers/$resellerId/tenants',
      data: body,
      options: _options,
    ),
  );

  Future<Json> update({
    required bool reseller,
    required String id,
    required Json body,
  }) => _body(
    _dio.patch<Object?>(
      reseller ? '/v1/resellers/$id' : '/v1/tenants/$id',
      data: body,
      options: _options,
    ),
  );

  Future<void> setSuspended({
    required bool reseller,
    required String id,
    required bool suspended,
  }) async {
    final base = reseller ? '/v1/resellers' : '/v1/tenants';
    await _dio.post<Object?>(
      '$base/$id/${suspended ? 'suspend' : 'resume'}',
      options: _options,
    );
  }

  /// The reseller's brand, or null when none has been saved yet.
  Future<Json?> brand(String resellerId) async {
    try {
      return await _body(
        _dio.get<Object?>('/v1/resellers/$resellerId/brand', options: _options),
      );
    } on DioException catch (e) {
      if (e.response?.statusCode == 404) return null;
      rethrow;
    }
  }

  Future<Json> saveBrand(String resellerId, Json body) => _body(
    _dio.put<Object?>(
      '/v1/resellers/$resellerId/brand',
      data: body,
      options: _options,
    ),
  );

  Future<List<Json>> baseDomains(String resellerId) =>
      _rows('/v1/resellers/$resellerId/base-domains');

  Future<Json> addBaseDomain(String resellerId, String fqdn) => _body(
    _dio.post<Object?>(
      '/v1/resellers/$resellerId/base-domains',
      data: {'fqdn': fqdn},
      options: _options,
    ),
  );

  /// Asks the service to look for the TXT record; a domain that is not proved
  /// yet answers 409 `domain_not_verified`.
  Future<Json> verifyBaseDomain(String resellerId, String domainId) => _body(
    _dio.post<Object?>(
      '/v1/resellers/$resellerId/base-domains/$domainId/verify',
      options: _options,
    ),
  );

  /// The tenant's primary domain, or null when none is assigned.
  Future<Json?> tenantDomain(String tenantId) async {
    try {
      return await _body(
        _dio.get<Object?>('/v1/tenants/$tenantId/domain', options: _options),
      );
    } on DioException catch (e) {
      if (e.response?.statusCode == 404) return null;
      rethrow;
    }
  }

  /// Uploads a brand image: asks for a presigned URL, sends the bytes to it,
  /// and returns the storage key to save on the brand.
  Future<String> uploadBrandAsset(
    String resellerId, {
    required String kind,
    required String contentType,
    required List<int> bytes,
  }) async {
    final ticket = await _body(
      _dio.post<Object?>(
        '/v1/resellers/$resellerId/brand/assets',
        data: {'kind': kind, 'contentType': contentType},
        options: _options,
      ),
    );
    // The presigned URL carries its own authority: no bearer token, and no
    // cookies (a credentialed request to the storage host would be refused).
    // A plain client rather than the API's, so none of the API's own headers
    // go along either: storage's CORS rule allows `Content-Type` only (G-80).
    // It shares the API's transport, which is what tests look at.
    final storage = Dio()..httpClientAdapter = _dio.httpClientAdapter;
    await storage.put<Object?>(
      '${ticket['uploadUrl']}',
      data: Uint8List.fromList(bytes),
      options: Options(
        headers: {Headers.contentTypeHeader: contentType},
        extra: {'withCredentials': false},
      ),
    );
    return '${ticket['key']}';
  }

  Future<List<Json>> consoleHostnames(String resellerId) =>
      _rows('/v1/resellers/$resellerId/console-hostnames');

  Future<Json> addConsoleHostname(String resellerId, String fqdn) => _body(
    _dio.post<Object?>(
      '/v1/resellers/$resellerId/console-hostnames',
      data: {'fqdn': fqdn},
      options: _options,
    ),
  );
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

final brandProviderFor = FutureProvider.family<Json?, String>((
  ref,
  resellerId,
) {
  return ref.watch(orgsApiProvider)?.brand(resellerId) ?? Future.value();
});

final baseDomainsProvider = FutureProvider.family<List<Json>, String>((
  ref,
  resellerId,
) async {
  return await ref.watch(orgsApiProvider)?.baseDomains(resellerId) ?? const [];
});

final tenantDomainProvider = FutureProvider.family<Json?, String>((
  ref,
  tenantId,
) {
  return ref.watch(orgsApiProvider)?.tenantDomain(tenantId) ?? Future.value();
});

final consoleHostnamesProvider = FutureProvider.family<List<Json>, String>((
  ref,
  resellerId,
) async {
  return await ref.watch(orgsApiProvider)?.consoleHostnames(resellerId) ??
      const [];
});
