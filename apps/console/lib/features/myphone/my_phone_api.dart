import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/acting.dart';
import '../../core/api_client.dart';
import '../../core/permissions.dart';
import '../../core/session.dart';
import '../pbx/pbx_api.dart';
import '../voicemail/voicemail_api.dart';

/// A person's own phone: `/v1/tenants/{tenantId}/me/...` (end-user
/// self-service). Nothing here names an extension, mailbox or user: the
/// services work out whose it is from who signed in, so there is no id this
/// screen could get wrong or point at someone else. It is [MailboxOps] so the
/// voicemail screens work on it unchanged; the mailbox id they pass is ignored.
class MyPhoneApi implements MailboxOps {
  MyPhoneApi(this._dio, this.tenantId, this._token);

  final Dio _dio;
  final String tenantId;
  final String _token;

  Options get _options => Options(headers: {'Authorization': 'Bearer $_token'});
  String _path(String tail) => '/v1/tenants/$tenantId/me/$tail';

  Future<Json> _get(String tail, {Map<String, Object>? query}) async {
    final response = await _dio.get<Object?>(
      _path(tail),
      queryParameters: query,
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  Future<List<Json>> _rows(String tail) async {
    final body = await _get(tail);
    return [
      for (final r in body['rows'] as List) (r as Map).cast<String, dynamic>(),
    ];
  }

  /// My extension: `id`, `number`, `displayName`, caller ID and whether it has
  /// voicemail. Throws a 404 (`no_linked_extension`) when none is linked.
  Future<Json> extension() => _get('extension');

  /// Everyone's extension number and name, for choosing where to forward to.
  Future<List<Json>> directory() => _rows('directory');

  Future<Json> callHandling() => _get('call-handling');

  Future<Json> saveCallHandling(Json body) async {
    final response = await _dio.put<Object?>(
      _path('call-handling'),
      data: body,
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  /// My mailbox: unread count, greeting and email settings. 404s with
  /// `no_linked_extension` or `no_mailbox`.
  Future<Json> voicemail() => _get('voicemail');

  @override
  Future<List<Json>> messages(String mailboxId) => _rows('voicemail/messages');

  @override
  Future<String> playUrl(String mailboxId, String messageId) async {
    final body = await _get('voicemail/messages/$messageId/play-url');
    return '${body['url']}';
  }

  Future<void> markRead(String messageId) async {
    await _dio.post<Object?>(
      _path('voicemail/messages/$messageId/read'),
      options: _options,
    );
  }

  @override
  Future<void> deleteMessage(String mailboxId, String messageId) async {
    await _dio.delete<Object?>(
      _path('voicemail/messages/$messageId'),
      options: _options,
    );
  }

  @override
  Future<Json> saveEmailSettings(
    String mailboxId,
    EmailSettings settings,
  ) async {
    final response = await _dio.put<Object?>(
      _path('voicemail/email-settings'),
      data: settings.toJson(),
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  @override
  Future<void> resetPin(String mailboxId, String pin) async {
    await _dio.post<Object?>(
      _path('voicemail/reset-pin'),
      data: {'pin': pin},
      options: _options,
    );
  }

  /// One page of my calls, newest first. The service fixes the number to my
  /// own extension's; only these narrowings can be asked for.
  Future<MyCallsPage> calls({
    String? direction,
    DateTime? from,
    DateTime? to,
    String? cursor,
    int limit = 25,
  }) async {
    final body = await _get(
      'calls',
      query: {
        'direction': ?direction,
        if (from != null)
          'from': DateTime(
            from.year,
            from.month,
            from.day,
          ).toUtc().toIso8601String(),
        if (to != null)
          'to': DateTime(
            to.year,
            to.month,
            to.day,
            23,
            59,
            59,
            999,
          ).toUtc().toIso8601String(),
        'cursor': ?cursor,
        'limit': limit,
      },
    );
    return MyCallsPage([
      for (final r in body['rows'] as List) (r as Map).cast<String, dynamic>(),
    ], body['nextCursor'] as String?);
  }
}

/// One page of my call history and where the next starts (null at the end).
class MyCallsPage {
  const MyCallsPage(this.rows, this.nextCursor);

  final List<Json> rows;
  final String? nextCursor;
}

/// The tenant the signed-in person belongs to, when "my phone" applies: a
/// person of a tenant, not acting as one (a reseller or the master has no
/// extension of their own to manage).
final _myTenantProvider = Provider<String?>((ref) {
  final session = ref.watch(sessionProvider);
  if (session == null || session.orgType != OrgType.tenant) return null;
  if (ref.watch(actingProvider) != null) return null;
  return session.orgId;
});

final myPhoneApiProvider = Provider<MyPhoneApi?>((ref) {
  final tenant = ref.watch(_myTenantProvider);
  final session = ref.watch(sessionProvider);
  if (tenant == null || session == null) return null;
  return MyPhoneApi(ref.watch(apiProvider).dio, tenant, session.accessToken);
});

/// The same object as [MailboxOps], for the voicemail screens.
final myVoicemailApiProvider = Provider<MailboxOps?>(
  (ref) => ref.watch(myPhoneApiProvider),
);

/// Whether an error is the service saying the person has no linked extension.
bool isNoLinkedExtension(Object error) =>
    error is DioException &&
    error.response?.statusCode == 404 &&
    (error.response?.data as Map?)?['code'] == 'no_linked_extension';

/// My extension, or null when none is linked or "my phone" does not apply
/// (not a tenant person, or without `self.settings`). It decides whether an
/// administrator is offered My phone at all.
final myExtensionProvider = FutureProvider<Json?>((ref) async {
  final api = ref.watch(myPhoneApiProvider);
  final held = ref.watch(knownPermissionsProvider);
  if (api == null || held == null || !held.contains('self.settings')) {
    return null;
  }
  try {
    return await api.extension();
  } catch (_) {
    // No extension linked, or the lookup failed: either way there is no My
    // phone to offer. The pages themselves say why when opened directly.
    return null;
  }
});

final myCallHandlingProvider = FutureProvider<Json>((ref) async {
  final api = ref.watch(myPhoneApiProvider);
  if (api == null) throw StateError('Not a tenant person.');
  return api.callHandling();
});

final myDirectoryProvider = FutureProvider<List<Json>>((ref) async {
  final api = ref.watch(myPhoneApiProvider);
  return api == null ? const [] : api.directory();
});

final myMailboxProvider = FutureProvider<Json>((ref) async {
  final api = ref.watch(myPhoneApiProvider);
  if (api == null) throw StateError('Not a tenant person.');
  return api.voicemail();
});

final myMessagesProvider = FutureProvider<List<Json>>((ref) async {
  final api = ref.watch(myPhoneApiProvider);
  return api == null ? const [] : api.messages('');
});
