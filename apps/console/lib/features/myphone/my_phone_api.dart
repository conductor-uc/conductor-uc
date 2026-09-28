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

  /// Where my phone or app signs in: server, port, transports (S9-11).
  Future<Json> sipEndpoint() => _get('sip-endpoint');

  /// S9-20: the queues I answer as an agent, and how many callers wait in
  /// each; empty when I answer none.
  Future<List<Json>> myQueues() async => [
    for (final q in ((await _get('queues'))['queues'] as List? ?? const []))
      (q as Map).cast<String, dynamic>(),
  ];

  /// S9-13: my own status as an agent (`available`, `on_break`,
  /// `logged_out`, or null until known), as the `*45`/`*46` codes set it.
  Future<Json> agentStatus() => _get('agent-status');

  Future<Json> setAgentStatus(String status) async {
    final response = await _dio.put<Object?>(
      _path('agent-status'),
      data: {'status': status},
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  /// S9-18: the calls ringing within my pickup groups, oldest first.
  Future<List<Json>> pickupable() async => [
    for (final c in ((await _get('pickup'))['calls'] as List? ?? const []))
      (c as Map).cast<String, dynamic>(),
  ];

  /// S9-18: takes [callUuid] (or the oldest ringing in my groups) on my own
  /// phone, which rings first.
  Future<void> pickup([String? callUuid]) async {
    await _dio.post<Object?>(
      _path('pickup'),
      data: {'callUuid': ?callUuid},
      options: _options.copyWith(receiveTimeout: const Duration(seconds: 60)),
    );
  }

  /// My own SIP username and password, to set up a phone or app (S9-11).
  /// Audited, as a credential.
  Future<Json> revealMySignIn() async {
    final response = await _dio.post<Object?>(
      _path('extension/reveal'),
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  /// Where to put my new greeting (a WAV), then that it is there (S9-11).
  Future<Json> presignGreeting() async {
    final response = await _dio.post<Object?>(
      _path('voicemail/greeting/presign'),
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  Future<Json> completeGreeting() async {
    final response = await _dio.post<Object?>(
      _path('voicemail/greeting/complete'),
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

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
    String? search,
    DateTime? from,
    DateTime? to,
    String? cursor,
    int limit = 25,
  }) async {
    final body = await _get(
      'calls',
      query: {
        'direction': ?direction,
        if (search != null && search.trim().isNotEmpty) 'search': search.trim(),
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
