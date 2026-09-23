import 'package:console_api/console_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../dev/demo_backend.dart';
import 'config.dart';

/// The one place the client is built. The console talks only to api-gateway
/// (08 §1); demo mode swaps in canned responses for development.
///
/// The refresh token lives in an HttpOnly cookie (07 §2), so page script never
/// holds it: every request asks for cookie-only transport, and the browser is
/// told to send cookies with them.
ConsoleApi createApi() {
  if (demoMode) return demoApi();
  final dio = Dio(
    BaseOptions(
      baseUrl: apiBaseUrl,
      connectTimeout: const Duration(seconds: 5),
      receiveTimeout: const Duration(seconds: 15),
      headers: {'x-refresh-transport': 'cookie'},
      extra: {'withCredentials': true},
    ),
  );
  return ConsoleApi(dio: dio);
}

final apiProvider = Provider<ConsoleApi>((ref) => createApi());
