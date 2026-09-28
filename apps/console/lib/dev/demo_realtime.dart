import 'dart:async';
import 'dart:convert';

import '../core/realtime_socket.dart';

/// A stand-in for the gateway's realtime hub in demo mode
/// (`--dart-define=DEMO=true`), answering the same protocol with canned data:
/// any token is accepted, and each tenant has the same few live calls and the
/// same presence board. Nothing changes on its own (no timers); only the
/// recording buttons change a call ([demoRecordingAction]), so it is
/// deterministic in tests.
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
List<Map<String, Object?>> demoLiveCalls(DateTime now) => [
  for (final leg in _cannedCalls(now))
    if (!_ended.contains(leg['callUuid']))
      {...leg, ...?_changes[leg['callUuid']]},
  for (final leg in _extra)
    if (!_ended.contains(leg['callUuid']))
      {...leg, ...?_changes[leg['callUuid']]},
];

List<Map<String, Object?>> _cannedCalls(DateTime now) {
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
    // S9-14: the outside caller above, ringing extension 104's phone, and a
    // caller waiting in the Support queue.
    {
      'callUuid': 'demo-b2',
      'direction': 'outbound',
      'state': 'ringing',
      'from': '+15550142',
      'to': '104',
      'startedAt': ago(7),
      'answeredAt': null,
      'bridgedTo': null,
      'recording': 'off',
      'controls': 'none',
      'extension': '104',
    },
    {
      'callUuid': 'demo-q1',
      'direction': 'inbound',
      'state': 'answered',
      'from': '+15550177',
      'to': '+15550100',
      'startedAt': ago(65),
      'answeredAt': ago(64),
      'bridgedTo': null,
      'recording': 'off',
      'controls': 'none',
      'extension': null,
      'queueId': 'q-1',
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

/// S9-14: what the attendant's buttons did to the demo's calls: legs gone,
/// legs added, and changes to legs.
final _ended = <String>{};
final _extra = <Map<String, Object?>>[];
final _changes = <String, Map<String, Object?>>{};
var _nextLeg = 0;

/// The caller a ringing phone's leg was placed for (a pickup takes it).
const _callerOf = {'demo-b2': 'demo-b1'};

/// Each demo queue agent's status, as the attendant's menu leaves it.
final _agentStatus = <String, String>{};

/// The demo tenant's queues, as the `queues` topic sends them (S9-13).
List<Map<String, Object?>> demoQueues(DateTime now) {
  final waiting = [
    for (final leg in demoLiveCalls(now))
      if (leg['queueId'] == 'q-1' && leg['bridgedTo'] == null) leg,
  ];
  return [
    {
      'queueId': 'q-1',
      'waiting': waiting.length,
      'longestWaitingSince': waiting.isEmpty
          ? null
          : waiting.first['startedAt'],
      'answered': 0,
      'callsAnswered': 12,
      'callsAbandoned': 1,
      'agents': [
        {
          'extension': '103',
          'status': _agentStatus['103'] ?? 'available',
          'activity': 'on_call',
          'callsAnswered': 12,
          'statusSince': null,
        },
      ],
    },
  ];
}

/// What an attendant's button does in the demo (S9-12, S9-13): `(status,
/// body)` for the demo backend to answer with. The calls change as the
/// service's would, and every open live view hears of it a moment later.
(int, Map<String, Object?>) demoCallAction(
  String action,
  String? callUuid,
  Map<String, Object?> body,
) {
  final legs = demoLiveCalls(DateTime.now());
  Map<String, Object?>? find(String? id) =>
      legs.where((l) => l['callUuid'] == id).firstOrNull;
  (int, Map<String, Object?>) problem(int status, String code, String detail) =>
      (status, {'code': code, 'detail': detail});
  final notFound = problem(
    404,
    'call_not_found',
    'There is no such call in progress.',
  );
  final leg = find(callUuid);
  final events = <Map<String, Object?>>[];
  final now = DateTime.now().toUtc().toIso8601String();

  void end(String id) {
    _ended.add(id);
    events.add({
      'type': 'call.ended',
      'callUuid': id,
      'hangupCause': 'NORMAL_CLEARING',
    });
  }

  void change(String id, Map<String, Object?> changes) {
    (_changes[id] ??= {}).addAll(changes);
    events.add({'type': 'call.updated', 'callUuid': id, 'changes': changes});
  }

  Map<String, Object?> add(Map<String, Object?> newLeg) {
    _extra.add(newLeg);
    events.add({'type': 'call.started', 'call': newLeg});
    return newLeg;
  }

  List<String> partners(Map<String, Object?> of) => [
    for (final other in legs)
      if (other['callUuid'] != of['callUuid'] &&
          (other['bridgedTo'] == of['callUuid'] ||
              of['bridgedTo'] == other['callUuid']))
        '${other['callUuid']}',
  ];

  Map<String, Object?> phoneLeg(String from, String to, String? bridgedTo) => {
    'callUuid': 'demo-x${_nextLeg++}',
    'direction': 'outbound',
    'state': 'answered',
    'from': from,
    'to': to,
    'startedAt': now,
    'answeredAt': now,
    'bridgedTo': bridgedTo,
    'recording': 'off',
    'controls': 'none',
    'extension': RegExp(r'^[0-9]{2,6}$').hasMatch(to) ? to : null,
  };

  final (int, Map<String, Object?>) answer;
  switch (action) {
    case 'hangup':
      if (leg == null) return notFound;
      partners(leg).forEach(end);
      end('${leg['callUuid']}');
      answer = (200, {'result': 'hungup'});
    case 'transfer':
      if (leg == null) return notFound;
      partners(leg).forEach(end);
      final to = '${body['to']}';
      final added = add(phoneLeg('${leg['from']}', to, '${leg['callUuid']}'));
      change('${leg['callUuid']}', {
        'bridgedTo': added['callUuid'],
        'state': 'answered',
        'parked': null,
      });
      answer = (200, {'result': 'transferred', 'callUuid': leg['callUuid']});
    case 'park':
      if (leg == null) return notFound;
      if (body['parkingLotId'] != 'park-1') {
        return problem(
          404,
          'parking_lot_not_found',
          'There is no such parking lot.',
        );
      }
      final slot = 701 + legs.where((l) => l['parked'] != null).length;
      partners(leg).forEach(end);
      change('${leg['callUuid']}', {
        'bridgedTo': null,
        'parked': {'parkingLotId': 'park-1', 'slot': slot},
      });
      answer = (
        200,
        {'result': 'parked', 'parkingLotId': 'park-1', 'slot': slot},
      );
    case 'pickup':
      if (leg == null) return notFound;
      final caller = find(_callerOf[callUuid]);
      if (leg['state'] != 'ringing' || caller == null) {
        return problem(
          409,
          'call_not_ringing',
          'This call is not ringing a phone.',
        );
      }
      end('${leg['callUuid']}');
      final mine = add(phoneLeg('${caller['from']}', '101', null));
      change('${caller['callUuid']}', {
        'state': 'answered',
        'answeredAt': now,
        'bridgedTo': mine['callUuid'],
      });
      answer = (200, {'result': 'picked_up', 'callUuid': mine['callUuid']});
    case 'dial':
      final to = '${body['to']}';
      final parked = legs
          .where((l) => (l['parked'] as Map?)?['slot'].toString() == to)
          .firstOrNull;
      final mine = add(phoneLeg('101', parked == null ? to : '101', null));
      if (parked != null) {
        change('${parked['callUuid']}', {
          'parked': null,
          'bridgedTo': mine['callUuid'],
        });
      }
      answer = (200, {'result': 'dialing', 'callUuid': mine['callUuid']});
    default:
      return problem(400, 'bad_request', 'Unknown action.');
  }
  Timer(const Duration(milliseconds: 300), () {
    for (final socket in [..._sockets]) {
      for (final event in events) {
        socket._callEvent(event);
      }
    }
  });
  return answer;
}

/// Sets a demo queue agent's status, and tells every open queues view.
(int, Map<String, Object?>) demoAgentStatus(String extension, String status) {
  if (extension != '103') {
    return (
      404,
      {'code': 'not_an_agent', 'detail': 'That extension answers no queue.'},
    );
  }
  _agentStatus[extension] = status;
  Timer(const Duration(milliseconds: 300), () {
    for (final socket in [..._sockets]) {
      socket._queuesChanged();
    }
  });
  return (
    200,
    {
      'extension': extension,
      'status': status,
      'queueIds': ['q-1'],
    },
  );
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

/// The demo tenant's extensions on the presence board: every one of them, in
/// each of the five states. The three on the demo's calls are on a call; the
/// others have no name in the demo's extension list, so show as numbers.
const demoPresence = [
  {'extension': '101', 'state': 'on_call'},
  {'extension': '102', 'state': 'on_call'},
  {'extension': '103', 'state': 'on_call'},
  {'extension': '104', 'state': 'ringing'},
  {'extension': '105', 'state': 'idle'},
  {'extension': '106', 'state': 'dnd'},
  {'extension': '107', 'state': 'offline'},
  {'extension': '110', 'state': 'idle'},
];

/// What a listen, whisper or barge button does in the demo: `(status, body)`
/// for the demo backend to answer with, once the "phone" has "answered". A
/// call in progress that is answered or held can be joined; a ringing one
/// cannot, as the service says.
(int, Map<String, Object?>) demoMonitorAction(String callUuid, String mode) {
  final leg = demoLiveCalls(DateTime.now())
      .where((l) => l['callUuid'] == callUuid)
      .firstOrNull;
  if (leg == null) {
    return (
      404,
      {
        'code': 'call_not_found',
        'detail': 'There is no such call in progress.',
      },
    );
  }
  if (leg['state'] == 'ringing') {
    return (
      409,
      {
        'code': 'call_not_answered',
        'detail': 'This call has not been answered yet.',
      },
    );
  }
  return (
    200,
    {
      'mode': mode,
      'callUuid': callUuid,
      'monitorCallUuid': 'demo-monitor-$callUuid',
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

  /// A change to the tenant's calls, to every calls topic (not a person's own).
  void _callEvent(Map<String, Object?> event) {
    for (final topic in _topics) {
      if (topic.contains(':user:') && topic.endsWith(':calls')) continue;
      if (!topic.endsWith(':calls') && !topic.endsWith(':supervised')) continue;
      _reply({'type': 'event', 'topic': topic, 'event': event});
    }
    _queuesChanged();
  }

  void _queuesChanged() {
    for (final topic in _topics) {
      if (!topic.endsWith(':queues')) continue;
      _reply({
        'type': 'event',
        'topic': topic,
        'event': {
          'type': 'queues.changed',
          'queues': demoQueues(DateTime.now()),
        },
      });
    }
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
        } else if (topic.endsWith(':calls') || topic.endsWith(':supervised')) {
          // G-119 (1): the calls a person may monitor; in demo mode, all of them.
          _reply({
            'type': 'snapshot',
            'topic': topic,
            'data': {'calls': demoLiveCalls(DateTime.now())},
          });
        } else if (topic.endsWith(':queues')) {
          _reply({
            'type': 'snapshot',
            'topic': topic,
            'data': {'queues': demoQueues(DateTime.now())},
          });
        } else if (topic.endsWith(':presence')) {
          _reply({
            'type': 'snapshot',
            'topic': topic,
            'data': {'extensions': demoPresence},
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
void resetDemoRecordings() {
  _recording.clear();
  _ended.clear();
  _extra.clear();
  _changes.clear();
  _agentStatus.clear();
  _nextLeg = 0;
}
