import 'dart:convert';
import 'dart:typed_data';

import 'package:console_api/console_api.dart';
import 'package:dio/dio.dart';

import 'demo_pbx.dart';

/// A stand-in for api-gateway so the console can be clicked through without a
/// backend (`--dart-define=DEMO=true`). Development only: the real client is
/// used whenever DEMO is unset, and this is tree-shaken out of that build.
///
/// - Brand: a hostname containing "reseller" resolves to a sample brand,
///   anything else to neutral.
/// - Login: the email's local part picks the role (`master@`, `reseller@`,
///   anything else is a tenant user). Any password is accepted, except
///   `wrong`, which is rejected so the error state can be seen.
ConsoleApi demoApi() =>
    ConsoleApi(dio: Dio()..httpClientAdapter = _DemoAdapter());

class _DemoAdapter implements HttpClientAdapter {
  final _pbx = DemoPbx();

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final pbx = _pbx.handle(options);
    if (pbx != null) return pbx;
    switch (options.path) {
      case '/v1/public/brand':
        final host = '${options.queryParameters['host']}';
        return _json(
          host.contains('reseller')
              ? {
                  'neutral': false,
                  'displayName': 'Sample Reseller',
                  'primaryColor': '#6a1b9a',
                  'accentColor': '#00695c',
                  'legalFooter': 'Sample Reseller Ltd.',
                }
              : {'neutral': true},
        );
      case '/v1/auth/login':
        final body = options.data;
        final request = body is Map ? body : jsonDecode('$body') as Map;
        if (request['password'] == 'wrong') return _json({}, 401);
        final email = '${request['email']}';
        final orgType = email.startsWith('master')
            ? 'master'
            : email.startsWith('reseller')
            ? 'reseller'
            : 'tenant';
        return _json({
          'status': 'ok',
          'accessToken': _jwt({
            'org': 'demo-org',
            'ot': orgType,
            'perms': <String>[],
          }),
          'refreshToken': 'demo-refresh',
          'expiresIn': 900,
        });
    }
    return _json({}, 404);
  }

  ResponseBody _json(Object body, [int status = 200]) =>
      ResponseBody.fromString(
        jsonEncode(body),
        status,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );

  String _jwt(Map<String, Object?> claims) {
    String part(Object o) =>
        base64Url.encode(utf8.encode(jsonEncode(o))).replaceAll('=', '');
    return '${part({'alg': 'none'})}.${part(claims)}.demo';
  }

  @override
  void close({bool force = false}) {}
}
