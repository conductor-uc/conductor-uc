import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/realtime.dart';
import '../../core/session.dart';
import '../pbx/pbx_api.dart';

/// call-control's operations on live calls and agents (S9-12, S9-13), as the
/// attendant console uses them. Every call the receptionist takes part in
/// rings their own phone (O-14): a pickup, taking back a parked call, a call
/// placed from the directory.
class AttendantApi {
  AttendantApi(this._dio, this._token, this.tenantId);

  final Dio _dio;
  final String _token;
  final String tenantId;

  /// A pickup or a call placed rings the receptionist's phone first, for up to
  /// 30 s, before the request answers.
  static const patience = Duration(seconds: 60);

  Options get _options => Options(
    headers: {'Authorization': 'Bearer $_token'},
    receiveTimeout: patience,
  );

  Future<Json> _post(String path, [Json? body]) async {
    final response = await _dio.post<Object?>(
      '/v1/tenants/$tenantId/$path',
      data: body,
      options: _options,
    );
    return (response.data as Map?)?.cast<String, dynamic>() ?? const {};
  }

  /// Sends [callUuid] (the caller's leg) to [to]; whoever it was talking to is
  /// let go.
  Future<Json> transfer(String callUuid, String to) =>
      _post('calls/$callUuid/transfer', {'to': to});

  /// Parks [callUuid] in [parkingLotId]'s first free slot; answers the slot.
  Future<Json> park(String callUuid, String parkingLotId) =>
      _post('calls/$callUuid/park', {'parkingLotId': parkingLotId});

  /// Takes a call ringing someone else's phone, on the receptionist's own.
  Future<Json> pickup(String ringingLeg) => _post('calls/$ringingLeg/pickup');

  Future<Json> hangup(String callUuid) => _post('calls/$callUuid/hangup');

  /// Rings the receptionist's own phone, then dials [to] from it. Dialing a
  /// parking slot takes back the call parked there.
  Future<Json> dial(String to) => _post('me/dial', {'to': to});

  /// Signs an agent in (`available`), out (`logged_out`) or on a break.
  Future<Json> setAgentStatus(String extension, String status) async {
    final response = await _dio.put<Object?>(
      '/v1/tenants/$tenantId/live-agents/$extension/status',
      data: {'status': status},
      options: _options,
    );
    return (response.data as Map?)?.cast<String, dynamic>() ?? const {};
  }
}

/// Null outside a tenant, or signed out.
final attendantApiProvider = Provider<AttendantApi?>((ref) {
  final session = ref.watch(sessionProvider);
  final tenant = ref.watch(tenantIdProvider);
  if (session == null || tenant == null) return null;
  return AttendantApi(ref.watch(apiProvider).dio, session.accessToken, tenant);
});

/// One agent of a queue, as the `queues` topic sends it.
class LiveAgent {
  const LiveAgent({
    required this.extension,
    required this.status,
    required this.activity,
  });

  final String extension;

  /// `available`, `on_break`, `logged_out`, or `other`.
  final String status;

  /// `waiting`, `ringing`, `on_call` or `idle`.
  final String activity;
}

/// One queue as it is now: counts and statuses, never a caller's number.
class LiveQueue {
  const LiveQueue({
    required this.queueId,
    required this.waiting,
    this.longestWaitingSince,
    required this.agents,
  });

  factory LiveQueue.fromJson(Map<String, dynamic> json) => LiveQueue(
    queueId: '${json['queueId']}',
    waiting: (json['waiting'] as num?)?.toInt() ?? 0,
    longestWaitingSince: DateTime.tryParse(
      '${json['longestWaitingSince'] ?? ''}',
    ),
    agents: [
      for (final a in (json['agents'] as List? ?? const []))
        if (a is Map)
          LiveAgent(
            extension: '${a['extension']}',
            status: '${a['status'] ?? 'other'}',
            activity: '${a['activity'] ?? 'idle'}',
          ),
    ],
  );

  final String queueId;
  final int waiting;
  final DateTime? longestWaitingSince;
  final List<LiveAgent> agents;
}

/// The tenant's queues from the realtime `queues` topic (S9-13): each message
/// carries the whole list. Null while connecting or when it stopped.
final liveQueuesProvider = StreamProvider.autoDispose<List<LiveQueue>?>((ref) {
  final tenant = ref.watch(tenantIdProvider);
  final client = ref.watch(realtimeClientProvider);
  if (tenant == null || client == null) return const Stream.empty();
  List<LiveQueue> parse(Object? list) => [
    for (final q in (list as List? ?? const []))
      if (q is Map) LiveQueue.fromJson(q.cast<String, dynamic>()),
  ];
  List<LiveQueue>? last;
  return client
      .watch('tenant:$tenant:queues')
      .map(
        (message) => last = switch (message) {
          TopicSnapshot(:final data) => parse(data['queues']),
          TopicEvent(:final event) when event['type'] == 'queues.changed' =>
            parse(event['queues']),
          TopicStopped() => null,
          _ => last,
        },
      );
});
