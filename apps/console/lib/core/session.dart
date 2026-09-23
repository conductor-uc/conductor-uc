import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

enum OrgType { master, reseller, tenant }

/// The signed-in user, from the access token's claims (07 §2). The token is
/// only decoded here for display and navigation; the server verifies it.
class Session {
  const Session({
    required this.accessToken,
    required this.refreshToken,
    required this.orgId,
    required this.orgType,
    required this.permissions,
  });

  factory Session.fromTokens({
    required String accessToken,
    required String refreshToken,
  }) {
    final claims = decodeClaims(accessToken);
    return Session(
      accessToken: accessToken,
      refreshToken: refreshToken,
      orgId: claims['org'] as String? ?? '',
      orgType: OrgType.values.firstWhere(
        (t) => t.name == claims['ot'],
        orElse: () => OrgType.tenant,
      ),
      permissions: [...?(claims['perms'] as List?)?.cast<String>()],
    );
  }

  final String accessToken;
  final String refreshToken;
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

/// In memory only. Refresh-cookie handling and silent refresh are S3-04.
class SessionController extends Notifier<Session?> {
  @override
  Session? build() => null;

  void signIn(Session session) => state = session;

  void signOut() => state = null;
}

final sessionProvider = NotifierProvider<SessionController, Session?>(
  SessionController.new,
);
