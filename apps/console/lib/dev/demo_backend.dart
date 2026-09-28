import 'dart:convert';
import 'dart:typed_data';

import 'package:console_api/console_api.dart';
import 'package:dio/dio.dart';

import 'demo_access.dart';
import 'demo_operations.dart';
import 'demo_pbx.dart';
import 'demo_realtime.dart';

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
  final _operations = DemoOperations();
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
    final recording = _recordingControl(options);
    if (recording != null) return recording;
    final operation = _callOperation(options);
    if (operation != null) return operation;
    final monitor = await _monitor(options);
    if (monitor != null) return monitor;
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

  /// The recording buttons on a live call (S5-15), a supervisor's and a
  /// person's own: they change the demo hub's calls ([demoRecordingAction]).
  ResponseBody? _recordingControl(RequestOptions options) {
    final match = RegExp(
      r'^/v1/tenants/[^/]+/(calls|me/live-calls)/([^/]+)/recording$',
    ).firstMatch(options.path);
    if (match == null || options.method != 'POST') return null;
    final (status, body) = demoRecordingAction(
      match.group(2)!,
      '${_body(options)['action']}',
      mine: match.group(1) != 'calls',
    );
    return status == 200
        ? _json(body)
        : _problem(status, '${body['code']}', '${body['detail']}');
  }

  /// Moving live calls and agents (S9-12, S9-13), for the attendant console:
  /// the demo hub's calls change as the service's would ([demoCallAction]).
  ResponseBody? _callOperation(RequestOptions options) {
    final path = options.path;
    final call = RegExp(
      r'^/v1/tenants/[^/]+/calls/([^/]+)/(hangup|transfer|park|pickup)$',
    ).firstMatch(path);
    final dial = RegExp(r'^/v1/tenants/[^/]+/me/dial$').hasMatch(path);
    // S9-21: a transfer from the person's own phone, attended or not.
    final mine = RegExp(
      r'^/v1/tenants/[^/]+/me/live-calls/([^/]+)/transfer(?:/(complete|cancel))?$',
    ).firstMatch(path);
    final agent = RegExp(r'^/v1/tenants/[^/]+/live-agents/([^/]+)/status$')
        .firstMatch(path);
    // Hang up and pick up have no body.
    Map<String, Object?> sent() => options.data == null
        ? const {}
        : _body(options).cast<String, Object?>();
    final (int, Map<String, Object?>) result;
    if (call != null && options.method == 'POST') {
      result = demoCallAction(call.group(2)!, call.group(1), sent());
    } else if (mine != null && options.method == 'POST') {
      final step = mine.group(2);
      final body = sent();
      result = step != null
          ? demoCallAction(step, mine.group(1), const {})
          : body['attended'] == true
          ? demoCallAction('consult', mine.group(1), body)
          : demoCallAction('transfer', mine.group(1), body);
    } else if (dial && options.method == 'POST') {
      result = demoCallAction('dial', null, sent());
    } else if (agent != null && options.method == 'PUT') {
      result = demoAgentStatus(agent.group(1)!, '${_body(options)['status']}');
    } else {
      return null;
    }
    final (status, body) = result;
    return status == 200
        ? _json(body)
        : _problem(status, '${body['code']}', '${body['detail']}');
  }

  /// Listen, whisper and barge on a live call (S5-09): the demo's "phone"
  /// answers after a moment, so the pending state can be seen
  /// ([demoMonitorAction]).
  Future<ResponseBody?> _monitor(RequestOptions options) async {
    final match = RegExp(
      r'^/v1/tenants/[^/]+/calls/([^/]+)/(listen|whisper|barge)$',
    ).firstMatch(options.path);
    if (match == null || options.method != 'POST') return null;
    final (status, body) = demoMonitorAction(match.group(1)!, match.group(2)!);
    if (status == 200) {
      await Future<void>.delayed(const Duration(milliseconds: 1500));
    }
    return status == 200
        ? _json(body)
        : _problem(status, '${body['code']}', '${body['detail']}');
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

  /// What the user may do, their org's audit trail, and the Operations console.
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
        // S9-05: who is signed in and where, for the header.
        'displayName': demoDisplayName(_email),
        'email': _email,
        'orgName': switch (_orgType) {
          'master' => 'Platform',
          'reseller' => 'Northwind Telecom',
          _ => 'Acme Dental',
        },
      });
    }
    if (RegExp(r'^/v1/orgs/[^/]+/audit-events$').hasMatch(path)) {
      return _json({'rows': demoAuditEvents(path.split('/')[3], _orgType)});
    }
    if (path == '/v1/platform/overview' ||
        path.startsWith('/v1/platform/nodes/')) {
      return _operationsRoute(options);
    }
    return null;
  }

  /// The overview and the media node actions (11 §2.2): the master only, and
  /// the actions only for someone who holds `platform.operate`.
  ResponseBody _operationsRoute(RequestOptions options) {
    final permissions = demoPermissions(_orgType, _email) ?? const [];
    if (_orgType != 'master' || !permissions.contains('platform.observe')) {
      return _problem(403, 'forbidden', 'Only the master can see operations.');
    }
    if (options.path == '/v1/platform/overview') {
      return _json(_operations.overview());
    }
    final match = RegExp(r'^/v1/platform/nodes/([^/]+)/(drain|undrain|weight)$')
        .firstMatch(options.path);
    if (match == null) return _problem(404, 'not_found', 'No such route.');
    if (!permissions.contains('platform.operate')) {
      return _problem(403, 'forbidden', 'You cannot change media nodes.');
    }
    final nodeId = Uri.decodeComponent(match[1]!);
    final Map<String, Object?>? node;
    switch (match[2]) {
      case 'weight':
        if (options.method != 'PUT') {
          return _problem(405, 'method_not_allowed', 'Use PUT.');
        }
        final weight = _body(options)['weight'];
        if (weight is! int || weight < 1 || weight > 999) {
          return _problem(400, 'validation', 'The weight must be 1 to 999.');
        }
        node = _operations.setWeight(nodeId, weight);
      default:
        if (options.method != 'POST') {
          return _problem(405, 'method_not_allowed', 'Use POST.');
        }
        node = _operations.drain(nodeId, draining: match[2] == 'drain');
    }
    return node == null
        ? _problem(404, 'not_found', 'No such node.')
        : _json(node);
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

/// "maria.lopez@x" → "Maria Lopez": a readable name for the demo's people.
String demoDisplayName(String email) => email
    .split('@')
    .first
    .split(RegExp(r'[._-]+'))
    .where((w) => w.isNotEmpty)
    .map((w) => '${w[0].toUpperCase()}${w.substring(1)}')
    .join(' ');
