import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/session.dart';
import '../pbx/pbx_api.dart';

/// The platform's Let's Encrypt settings and the certificates it keeps.
class CertificatesApi {
  CertificatesApi(this._dio, this._token);

  final Dio _dio;
  final String _token;

  Options get _options => Options(headers: {'Authorization': 'Bearer $_token'});

  Future<Json> _object(Future<Response<Object?>> call) async =>
      ((await call).data as Map).cast<String, dynamic>();

  Future<List<Json>> _rows(String path) async {
    final response = await _dio.get<Object?>(path, options: _options);
    final rows = (response.data as Map)['rows'] as List;
    return [for (final r in rows) (r as Map).cast<String, dynamic>()];
  }

  /// The Let's Encrypt address, environment and agreement (the operator's alone).
  Future<Json> acmeSettings() => _object(
    _dio.get<Object?>('/v1/platform/acme-settings', options: _options),
  );

  Future<Json> saveAcmeSettings({
    required String? contactEmail,
    required String directory,
    required bool agreeToTerms,
  }) => _object(
    _dio.put<Object?>(
      '/v1/platform/acme-settings',
      data: {
        'contactEmail': contactEmail,
        'directory': directory,
        'agreeToTerms': agreeToTerms,
      },
      options: _options,
    ),
  );

  /// Where the platform is reached from the internet (the operator's alone).
  Future<Json> networkSettings() => _object(
    _dio.get<Object?>('/v1/platform/network-settings', options: _options),
  );

  Future<Json> savePublicAddress(String? publicAddress) => _object(
    _dio.put<Object?>(
      '/v1/platform/network-settings',
      data: {'publicAddress': publicAddress},
      options: _options,
    ),
  );

  /// The DNS records a reseller publishes, one per name a certificate is kept for.
  Future<Json> resellerDnsRecords(String resellerId) => _object(
    _dio.get<Object?>(
      '/v1/resellers/$resellerId/dns-records',
      options: _options,
    ),
  );

  Future<List<Json>> platformCertificates() =>
      _rows('/v1/platform/certificates');

  Future<List<Json>> resellerCertificates(String resellerId) =>
      _rows('/v1/resellers/$resellerId/certificates');
}

final certificatesApiProvider = Provider<CertificatesApi?>((ref) {
  final session = ref.watch(sessionProvider);
  if (session == null) return null;
  return CertificatesApi(ref.watch(apiProvider).dio, session.accessToken);
});

final acmeSettingsProvider = FutureProvider.autoDispose<Json>((ref) async {
  final api = ref.watch(certificatesApiProvider);
  if (api == null) throw StateError('Not signed in.');
  return api.acmeSettings();
});

final platformCertificatesProvider = FutureProvider.autoDispose<List<Json>>((
  ref,
) async {
  return await ref.watch(certificatesApiProvider)?.platformCertificates() ??
      const [];
});

final resellerCertificatesProvider = FutureProvider.autoDispose
    .family<List<Json>, String>((ref, resellerId) async {
      return await ref
              .watch(certificatesApiProvider)
              ?.resellerCertificates(resellerId) ??
          const [];
    });

final networkSettingsProvider = FutureProvider.autoDispose<Json>((ref) async {
  final api = ref.watch(certificatesApiProvider);
  if (api == null) throw StateError('Not signed in.');
  return api.networkSettings();
});

final resellerDnsRecordsProvider = FutureProvider.autoDispose
    .family<Json, String>((ref, resellerId) async {
      final api = ref.watch(certificatesApiProvider);
      if (api == null) throw StateError('Not signed in.');
      return api.resellerDnsRecords(resellerId);
    });
