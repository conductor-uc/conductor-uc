import 'dart:async';
import 'dart:convert';

import 'package:console_api/console_api.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api_client.dart';

enum OrgType { master, reseller, tenant }

/// The signed-in user, from the access token's claims (07 §2). The token is
/// only decoded here for display and navigation; the server verifies it.
///
/// There is no refresh token here: it lives in an HttpOnly cookie the console
/// cannot read.
class Session {
  const Session({
    required this.accessToken,
    required this.expiresIn,
    required this.orgId,
    required this.orgType,
    required this.permissions,
  });

  factory Session.fromTokens(Tokens tokens) {
    final claims = decodeClaims(tokens.accessToken);
    return Session(
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
      orgId: claims['org'] as String? ?? '',
      orgType: OrgType.values.firstWhere(
        (t) => t.name == claims['ot'],
        orElse: () => OrgType.tenant,
      ),
      permissions: [...?(claims['perms'] as List?)?.cast<String>()],
    );
  }

  final String accessToken;
  final int expiresIn;
  final String orgId;
  final OrgType orgType;
  final List<String> permissions;
}

/// The unverified payload of a JWT.
Map<String, dynamic> decodeClaims(String jwt) {
  final parts = jwt.split('.');
  if (parts.length != 3) return const {};
  try {
    final json = utf8.decode(base64Url.decode(base64Url.normalize(parts[1])));
    return jsonDecode(json) as Map<String, dynamic>;
  } catch (_) {
    return const {};
  }
}

/// How long before the access token expires the silent refresh fires.
const refreshLead = Duration(seconds: 60);

/// The session, held in memory. A timer refreshes it shortly before the access
/// token expires, using the refresh cookie; if that is rejected (expired,
/// revoked, or reused) the user is signed out. On a page load, [restore] tries
/// the same refresh, so a reload keeps a signed-in user signed in.
class SessionController extends Notifier<Session?> {
  Timer? _timer;

  @override
  Session? build() {
    ref.onDispose(() => _timer?.cancel());
    return null;
  }

  void signIn(Tokens tokens) {
    final session = Session.fromTokens(tokens);
    state = session;
    _schedule(session);
  }

  /// Signs in again from the refresh cookie, if there is a good one. False
  /// when there is not, which is the normal state for a signed-out visitor.
  Future<bool> restore() => _refresh(silent: true);

  Future<void> signOut() async {
    _timer?.cancel();
    final wasSignedIn = state != null;
    state = null;
    if (!wasSignedIn) return;
    try {
      await ref
          .read(apiProvider)
          .getAuthApi()
          .logout(refreshRequest: RefreshRequest());
    } catch (_) {
      // Signed out here either way; the server-side session expires on its own.
    }
  }

  void _schedule(Session session) {
    _timer?.cancel();
    final delay = Duration(seconds: session.expiresIn) - refreshLead;
    _timer = Timer(
      delay.isNegative ? Duration.zero : delay,
      () => _refresh(silent: false),
    );
  }

  Future<bool> _refresh({required bool silent}) async {
    try {
      final response = await ref
          .read(apiProvider)
          .getAuthApi()
          .refreshTokens(refreshRequest: RefreshRequest());
      final tokens = response.data;
      if (tokens == null) throw StateError('empty refresh response');
      // A result that arrives after sign-out must not sign the user back in.
      if (!silent && state == null) return false;
      signIn(tokens);
      return true;
    } catch (_) {
      if (!silent && state != null) {
        _timer?.cancel();
        state = null;
      }
      return false;
    }
  }
}

final sessionProvider = NotifierProvider<SessionController, Session?>(
  SessionController.new,
);

/// A sign-in that needs a second factor before it yields a session.
sealed class AuthStep {
  const AuthStep();
}

class MfaEnrollStep extends AuthStep {
  const MfaEnrollStep({
    required this.ticket,
    required this.secret,
    required this.otpauthUri,
  });

  final String ticket;
  final String secret;
  final String otpauthUri;
}

class MfaVerifyStep extends AuthStep {
  const MfaVerifyStep({required this.ticket});

  final String ticket;
}

class AuthStepController extends Notifier<AuthStep?> {
  @override
  AuthStep? build() => null;

  void set(AuthStep? step) => state = step;
}

final authStepProvider = NotifierProvider<AuthStepController, AuthStep?>(
  AuthStepController.new,
);
