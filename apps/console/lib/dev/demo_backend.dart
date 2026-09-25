import 'dart:convert';
import 'dart:typed_data';

import 'package:console_api/console_api.dart';
import 'package:dio/dio.dart';

import 'demo_access.dart';
import 'demo_pbx.dart';

/// A stand-in for api-gateway so the console can be clicked through without a
/// backend (`--dart-define=DEMO=true`). Development only: the real client is
/// used whenever DEMO is unset, and this is tree-shaken out of that build.
///
/// - Brand: a hostname containing "reseller" resolves to a sample brand,
///   anything else to neutral.
/// - Login: the email's local part picks the role. `master@` asks for a code
///   (two-step verification), `reseller@` asks to set up an authenticator
///   first, anything else is a tenant user who signs in directly. Any
///   password works except `wrong`. The only accepted code is `123456`.
/// - Password reset: any account gets the same "sent" answer. On the confirm
///   page, the token `expired` is rejected and a short password is refused.
/// - Invitations: the token `expired` is invalid and `taken` conflicts; any
///   other token is a valid invitation for `new.person@example.test`.
ConsoleApi demoApi() =>
    ConsoleApi(dio: Dio()..httpClientAdapter = _DemoAdapter());

class _DemoAdapter implements HttpClientAdapter {
  final _pbx = DemoPbx();
  var _orgType = 'tenant';
  var _email = '';
  var _signedIn = false;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final access = _access(options);
    if (access != null) return access;
    final pbx = _pbx.handle(options, userId: demoUserId(_email));
    if (pbx != null) return pbx;
    switch (options.path) {
      case '/v1/public/brand':
        final host = '${options.queryParameters['host']}';
        return _json(
          host.contains('reseller')
              ? {
                  'neutral': false,
                  'displayName': 'Sample Reseller',
                  'primaryColor': '#4a148c',
                  'accentColor': '#ffe082',
                  'legalFooter': 'Sample Reseller Ltd.',
                }
              : {'neutral': true},
        );
      case '/v1/session/brand':
        // A reseller or tenant user is presented with the reseller's brand.
        return _json(
          _orgType == 'master'
              ? {'neutral': true}
              : {
                  'neutral': false,
                  'displayName': 'Sample Reseller',
                  'primaryColor': '#4a148c',
                  'accentColor': '#ffe082',
                  'legalFooter': 'Sample Reseller Ltd.',
                },
        );
      case '/v1/auth/login':
        final request = _body(options);
        if (request['password'] == 'wrong') return _json({}, 401);
        final email = '${request['email']}';
        final orgRequired = _orgRequired(email, request['orgId']);
        if (orgRequired != null) return orgRequired;
        _email = email;
        _orgType = email.startsWith('master')
            ? 'master'
            : email.startsWith('reseller')
            ? 'reseller'
            : 'tenant';
        return switch (_orgType) {
          'master' => _json({
            'status': 'mfa_verification_required',
            'verificationTicket': 'demo',
          }),
          'reseller' => _json({
            'status': 'mfa_enrollment_required',
            'enrollmentTicket': 'demo',
            'totp': {
              'secret': 'JBSWY3DPEHPK3PXP',
              'otpauthUri':
                  'otpauth://totp/Console:demo?secret=JBSWY3DPEHPK3PXP',
            },
          }),
          _ => _signIn(),
        };
      case '/v1/auth/mfa/verify':
      case '/v1/auth/mfa/enroll/confirm':
        return _body(options)['code'] == '123456'
            ? _signIn(plain: true)
            : _json({}, 401);
      case '/v1/auth/refresh':
        // The refresh cookie: present after a sign-in, until logout.
        return _signedIn ? _signIn(plain: true) : _json({}, 401);
      case '/v1/auth/logout':
        _signedIn = false;
        return ResponseBody.fromString('', 204);
      case '/v1/auth/password-reset':
        final request = _body(options);
        // An address this demo cannot place from the hostname alone.
        if (request['orgId'] == null &&
            '${request['email']}'.startsWith('nohost')) {
          return _problem(400, 'org_required', 'Enter your organization ID.');
        }
        return ResponseBody.fromString('', 202);
      case '/v1/auth/password-reset/confirm':
        final request = _body(options);
        if (request['token'] == 'expired') {
          return _problem(
            400,
            'invalid_reset_token',
            'This reset link is invalid or has expired.',
          );
        }
        if (request['token'] == 'shared') {
          return _problem(
            409,
            'password_in_use',
            'That password already signs in to another account with this email address. Choose a different password.',
          );
        }
        if ('${request['newPassword']}'.length < 12) {
          return _problem(
            400,
            'weak_password',
            'Password must be at least 12 characters.',
          );
        }
        return ResponseBody.fromString('', 204);
      case '/v1/auth/invitations/lookup':
        return _body(options)['token'] == 'expired'
            ? _problem(
                400,
                'invalid_invitation',
                'This invitation is invalid or has expired.',
              )
            : _json({
                'email': 'new.person@example.test',
                'displayName': 'New Person',
              });
      case '/v1/auth/invitations/accept':
        final request = _body(options);
        if (request['token'] == 'taken') {
          return _problem(
            409,
            'email_taken',
            'That email already has an account.',
          );
        }
        if (request['token'] == 'shared') {
          return _problem(
            409,
            'password_in_use',
            'That password already signs in to another account with this email address. Choose a different password.',
          );
        }
        if ('${request['password']}'.length < 12) {
          return _problem(
            400,
            'weak_password',
            'Password must be at least 12 characters.',
          );
        }
        return _json({
          'email': 'new.person@example.test',
          'orgId': 'demo-org',
        }, 201);
    }
    return _json({}, 404);
  }

  /// What the service says when the hostname does not name the org (an email
  /// starting `nohost`), or the same email and password are in two orgs
  /// (`shared`); null once an org id is given, or for everyone else.
  ResponseBody? _orgRequired(String email, Object? orgId) {
    if (orgId != null) return null;
    if (email.startsWith('nohost')) {
      return _problem(400, 'org_required', 'Enter your organization ID.');
    }
    if (email.startsWith('shared')) {
      return _problem(
        409,
        'org_required',
        'This address is used in more than one organization. Enter your organization ID.',
      );
    }
    return null;
  }

  Map<dynamic, dynamic> _body(RequestOptions options) {
    final data = options.data;
    return data is Map ? data : jsonDecode('$data') as Map;
  }

  /// Signs in: tokens for the chosen role, and the refresh cookie is "set".
  /// The refresh token is left out of the body, as with cookie transport.
  ResponseBody _signIn({bool plain = false}) {
    _signedIn = true;
    final tokens = {
      'accessToken': _jwt({
        'org': 'demo-org',
        'sub': 'user-1',
        'ot': _orgType,
        'perms': <String>[],
      }),
      'expiresIn': 900,
    };
    return _json(plain ? tokens : {'status': 'ok', ...tokens});
  }

  /// What the user may do, their org's audit trail, and platform health.
  ResponseBody? _access(RequestOptions options) {
    final path = options.path;
    if (RegExp(r'^/v1/orgs/[^/]+/me$').hasMatch(path)) {
      final permissions = demoPermissions(_orgType, _email);
      if (permissions == null) {
        return _problem(403, 'forbidden', 'You cannot see that.');
      }
      return _json({
        'userId': demoUserId(_email),
        'orgId': path.split('/')[3],
        'orgType': _orgType,
        'roleIds': const <String>[],
        'permissions': permissions,
      });
    }
    if (RegExp(r'^/v1/orgs/[^/]+/audit-events$').hasMatch(path)) {
      return _json({'rows': demoAuditEvents(path.split('/')[3], _orgType)});
    }
    if (path == '/v1/platform/health') {
      return _orgType == 'master'
          ? _json(demoPlatformHealth())
          : _problem(
              403,
              'forbidden',
              'Only the master can see platform health.',
            );
    }
    return null;
  }

  ResponseBody _problem(int status, String code, String detail) =>
      ResponseBody.fromString(
        jsonEncode({
          'title': 'Error',
          'status': status,
          'code': code,
          'detail': detail,
        }),
        status,
        headers: {
          Headers.contentTypeHeader: ['application/problem+json'],
        },
      );

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
