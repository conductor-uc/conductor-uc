import 'dart:async';
import 'dart:convert';

import '../core/realtime_socket.dart';

/// A stand-in for the gateway's realtime hub in demo mode
/// (`--dart-define=DEMO=true`), answering the same protocol with canned data:
/// any token is accepted, and each tenant has the same few live calls. Nothing
/// changes on its own (no timers), so it is deterministic in tests.
Future<RealtimeSocket> demoRealtimeConnector(Uri url) async =>
    DemoRealtimeSocket();

/// The demo's live calls, one entry per leg, as the gateway sends them: an
/// internal call (two bridged legs), an outside caller ringing an extension,
/// and a recorded outbound call.
List<Map<String, Object?>> demoLiveCalls(DateTime now) {
  String ago(int seconds) =>
      now.subtract(Duration(seconds: seconds)).toUtc().toIso8601String();
  return [
    {
      'callUuid': 'demo-a1',
      'direction': 'inbound',
      'state': 'answered',
      'from': '101',
      'to': '102',
      'startedAt': ago(95),
      'answeredAt': ago(90),
      'bridgedTo': 'demo-a2',
      'recording': 'off',
    },
    {
      'callUuid': 'demo-a2',
      'direction': 'outbound',
      'state': 'answered',
      'from': '101',
      'to': '102',
      'startedAt': ago(94),
      'answeredAt': ago(90),
      'bridgedTo': 'demo-a1',
      'recording': 'off',
    },
    {
      'callUuid': 'demo-b1',
      'direction': 'inbound',
      'state': 'ringing',
      'from': '+15550142',
      'to': '+15550100',
      'startedAt': ago(8),
      'answeredAt': null,
      'bridgedTo': null,
      'recording': 'off',
    },
    {
      'callUuid': 'demo-c1',
      'direction': 'inbound',
      'state': 'held',
      'from': '103',
      'to': '+15550199',
      'startedAt': ago(400),
      'answeredAt': ago(390),
      'bridgedTo': null,
      'recording': 'on',
    },
  ];
}

class DemoRealtimeSocket implements RealtimeSocket {
  final _messages = StreamController<String>();
  final _done = Completer<int>();

  @override
  Stream<String> get messages => _messages.stream;

  @override
  Future<int> get done => _done.future;

  void _reply(Map<String, Object?> message) {
    if (!_messages.isClosed) _messages.add(jsonEncode(message));
  }

  @override
  void send(String data) {
    final message = (jsonDecode(data) as Map).cast<String, dynamic>();
    final topic = message['topic'] as String?;
    switch (message['type']) {
      case 'auth':
        _reply({
          'type': 'authenticated',
          'v': 1,
          'expiresAt': DateTime.now()
              .add(const Duration(minutes: 10))
              .toUtc()
              .toIso8601String(),
        });
      case 'subscribe' when topic != null:
        _reply({'type': 'subscribed', 'topic': topic});
        if (topic.endsWith(':calls')) {
          _reply({
            'type': 'snapshot',
            'topic': topic,
            'data': {'calls': demoLiveCalls(DateTime.now())},
          });
        } else if (topic.endsWith(':presence')) {
          _reply({
            'type': 'snapshot',
            'topic': topic,
            'data': {
              'extensions': [
                {'extension': '101', 'state': 'on_call'},
                {'extension': '102', 'state': 'on_call'},
                {'extension': '103', 'state': 'on_call'},
              ],
            },
          });
        }
      case 'unsubscribe' when topic != null:
        _reply({'type': 'unsubscribed', 'topic': topic});
    }
  }

  @override
  void close([int code = 1000]) {
    if (!_done.isCompleted) _done.complete(code);
    unawaited(_messages.close());
  }
}
