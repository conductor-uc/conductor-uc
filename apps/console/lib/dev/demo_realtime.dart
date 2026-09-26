import 'dart:async';
import 'dart:convert';

import '../core/realtime_socket.dart';

/// A stand-in for the gateway's realtime hub in demo mode
/// (`--dart-define=DEMO=true`), answering the same protocol with canned data:
/// any token is accepted, and each tenant has the same few live calls. Nothing
/// changes on its own (no timers); only the recording buttons change a call
/// ([demoRecordingAction]), so it is deterministic in tests.
Future<RealtimeSocket> demoRealtimeConnector(Uri url) async =>
    DemoRealtimeSocket();

/// Each demo call's recording, by the leg that owns it (the caller's leg), as
/// the recording buttons leave it. Starts as [demoLiveCalls] says.
final _recording = <String, String>{};

/// The sockets open now, so a recording change reaches every live view.
final _sockets = <DemoRealtimeSocket>{};

/// The demo's live calls, one entry per leg, as the gateway sends them: an
/// internal call (two bridged legs) whose rule allows recording on demand, an
/// outside caller ringing an extension, and an outbound call a rule records
/// and allows pausing.
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
      'recording': _recording['demo-a1'] ?? 'off',
      'controls': 'on_demand',
      'extension': '101',
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
      'controls': 'on_demand',
      'extension': '102',
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
      'controls': 'none',
      'extension': null,
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
      'recording': _recording['demo-c1'] ?? 'on',
      'controls': 'pause',
      'extension': '103',
    },
  ];
}

/// The legs the demo person (`user@`, extension 101) is shown on their own
/// calls' topic: their leg and the leg bridged to it.
const _myLegs = {'demo-a1', 'demo-a2'};

/// What a recording button does in the demo, by the same rules the service
/// applies (the feature codes' rules): `(status, body)` for the demo backend
/// to answer with. A change reaches every open live view a moment later, as a
/// real one would.
(int, Map<String, Object?>) demoRecordingAction(
  String callUuid,
  String action, {
  required bool mine,
}) {
  final legs = demoLiveCalls(DateTime.now());
  final leg = legs.where((l) => l['callUuid'] == callUuid).firstOrNull;
  if (leg == null || (mine && !_myLegs.contains(callUuid))) {
    return (
      404,
      {
        'code': 'call_not_found',
        'detail': 'There is no such call in progress.',
      },
    );
  }
  // The caller's leg owns the recording.
  final owner = callUuid == 'demo-a2' ? 'demo-a1' : callUuid;
  final controls = leg['controls'] as String;
  final now = legs.firstWhere((l) => l['callUuid'] == owner)['recording'];
  (int, Map<String, Object?>) refuse(String code, String detail) =>
      (409, {'code': code, 'detail': detail});
  if (controls == 'none') {
    return refuse(
      'recording_not_allowed',
      "This call's recording rules do not allow that.",
    );
  }
  final String next;
  final String result;
  switch (action) {
    case 'start':
      if (controls != 'on_demand' || now != 'off') {
        return refuse(
          'already_recording',
          'This call is already being recorded.',
        );
      }
      (next, result) = ('on', 'started');
    case 'stop':
      if (controls != 'on_demand') {
        return refuse(
          'rule_recording',
          'A recording made by a rule cannot be stopped. It can be paused, if the rule allows.',
        );
      }
      if (now == 'off') {
        return refuse('not_recording', 'This call is not being recorded.');
      }
      (next, result) = ('off', 'stopped');
    case 'pause':
      if (now == 'off') {
        return refuse('not_recording', 'This call is not being recorded.');
      }
      if (now == 'paused') {
        return refuse(
          'already_paused',
          "This call's recording is already paused.",
        );
      }
      (next, result) = ('paused', 'paused');
    case 'resume':
      if (now != 'paused') {
        return refuse('not_paused', "This call's recording is not paused.");
      }
      (next, result) = ('on', 'resumed');
    default:
      return (400, {'code': 'bad_request', 'detail': 'Unknown action.'});
  }
  _recording[owner] = next;
  Timer(const Duration(milliseconds: 400), () {
    for (final socket in [..._sockets]) {
      socket._changed(owner, {'recording': next});
    }
  });
  return (
    200,
    {
      'result': result,
      'recordingId': 'demo-recording-$owner',
      'recording': next,
    },
  );
}

class DemoRealtimeSocket implements RealtimeSocket {
  DemoRealtimeSocket() {
    _sockets.add(this);
  }

  final _messages = StreamController<String>();
  final _done = Completer<int>();
  final _topics = <String>{};

  @override
  Stream<String> get messages => _messages.stream;

  @override
  Future<int> get done => _done.future;

  void _reply(Map<String, Object?> message) {
    if (!_messages.isClosed) _messages.add(jsonEncode(message));
  }

  /// A recording change on [callUuid], to every calls topic that shows it.
  void _changed(String callUuid, Map<String, Object?> changes) {
    for (final topic in _topics) {
      if (!topic.endsWith(':calls')) continue;
      if (topic.contains(':user:') && !_myLegs.contains(callUuid)) continue;
      _reply({
        'type': 'event',
        'topic': topic,
        'event': {
          'type': 'call.updated',
          'callUuid': callUuid,
          'changes': changes,
        },
      });
    }
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
        _topics.add(topic);
        _reply({'type': 'subscribed', 'topic': topic});
        if (topic.contains(':user:') && topic.endsWith(':calls')) {
          // A person's own calls: the demo person is on extension 101's call.
          _reply({
            'type': 'snapshot',
            'topic': topic,
            'data': {
              'calls': [
                for (final leg in demoLiveCalls(DateTime.now()))
                  if (_myLegs.contains(leg['callUuid'])) leg,
              ],
            },
          });
        } else if (topic.endsWith(':calls')) {
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
        _topics.remove(topic);
        _reply({'type': 'unsubscribed', 'topic': topic});
    }
  }

  @override
  void close([int code = 1000]) {
    _sockets.remove(this);
    if (!_done.isCompleted) _done.complete(code);
    unawaited(_messages.close());
  }
}

/// Forgets the demo's recording changes (tests start each from the canned calls).
void resetDemoRecordings() => _recording.clear();
