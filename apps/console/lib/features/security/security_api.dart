import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/session.dart';
import '../pbx/pbx_api.dart';

/// The platform's sign-in policy (D-012 as amended): whether the operator's
/// own administrators must use two-step verification.
class SecurityApi {
  SecurityApi(this._dio, this._token);

  final Dio _dio;
  final String _token;

  Options get _options => Options(headers: {'Authorization': 'Bearer $_token'});

  Future<Json> settings() async {
    final response = await _dio.get<Object?>(
      '/v1/platform/security-settings',
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  /// Turning the requirement off needs [stepUpCode], a current code from the
  /// signed-in administrator's own authenticator app (G-100); without a right
  /// one it answers 401 `step_up_required` or `step_up_invalid`.
  Future<Json> save({
    required bool requireMasterMfa,
    String? stepUpCode,
  }) async {
    final response = await _dio.put<Object?>(
      '/v1/platform/security-settings',
      data: {'requireMasterMfa': requireMasterMfa, 'stepUpCode': ?stepUpCode},
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }
}

final securityApiProvider = Provider<SecurityApi?>((ref) {
  final session = ref.watch(sessionProvider);
  if (session == null) return null;
  return SecurityApi(ref.watch(apiProvider).dio, session.accessToken);
});

final securitySettingsProvider = FutureProvider.autoDispose<Json>((ref) async {
  final api = ref.watch(securityApiProvider);
  if (api == null) throw StateError('Not signed in.');
  return api.settings();
});
