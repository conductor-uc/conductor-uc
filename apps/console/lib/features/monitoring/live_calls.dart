import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../core/realtime.dart';
import '../../core/session.dart';
import '../pbx/pbx_api.dart';

/// One leg of a live call, as the `tenant:{t}:calls` topic sends it.
class LiveCall {
  const LiveCall({
    required this.callUuid,
    required this.direction,
    required this.state,
    required this.from,
    required this.to,
    required this.startedAt,
    this.answeredAt,
    this.bridgedTo,
    this.recording = 'off',
    this.controls = 'none',
    this.extension,
    this.queueId,
    this.parked,
  });

  factory LiveCall.fromJson(Map<String, dynamic> json) => LiveCall(
    callUuid: json['callUuid'] as String,
    direction: json['direction'] as String? ?? 'inbound',
    state: json['state'] as String? ?? 'ringing',
    from: json['from'] as String? ?? '',
    to: json['to'] as String? ?? '',
    startedAt:
        DateTime.tryParse(json['startedAt'] as String? ?? '') ?? DateTime.now(),
    answeredAt: DateTime.tryParse(json['answeredAt'] as String? ?? ''),
    bridgedTo: json['bridgedTo'] as String?,
    recording: json['recording'] as String? ?? 'off',
    controls: json['controls'] as String? ?? 'none',
    extension: json['extension'] as String?,
    queueId: json['queueId'] as String?,
    parked: ParkedAt.fromJson(json['parked']),
  );

  final String callUuid;

  /// `inbound`: a leg that called in to the media node (a phone or a trunk
  /// dialling); `outbound`: a leg the node placed (ringing a phone or a number).
  final String direction;

  /// `ringing`, `answered` or `held`.
  final String state;
  final String from;
  final String to;
  final DateTime startedAt;
  final DateTime? answeredAt;
  final String? bridgedTo;

  /// `on`, `off`, or `paused` (by feature code or by the recording buttons).
  final String recording;

  /// Which recording buttons can work on the call, as decided when it was set
  /// up: `on_demand` (record and stop, and pause and resume while recording),
  /// `pause` (pause and resume a recording a rule started), or `none`.
  final String controls;

  /// The extension this leg belongs to, when the phone system vouches for it
  /// (a phone that called in, or the extension a leg rang); null otherwise.
  final String? extension;

  /// The queue this leg is in (a caller waiting or talking, or the agent).
  final String? queueId;

  /// Where the leg waits while it is parked (S9-14); null otherwise.
  final ParkedAt? parked;

  LiveCall apply(Map<String, dynamic> changes) => LiveCall(
    callUuid: callUuid,
    direction: direction,
    state: changes['state'] as String? ?? state,
    from: from,
    to: to,
    startedAt: startedAt,
    answeredAt: changes.containsKey('answeredAt')
        ? DateTime.tryParse(changes['answeredAt'] as String? ?? '')
        : answeredAt,
    bridgedTo: changes.containsKey('bridgedTo')
        ? changes['bridgedTo'] as String?
        : bridgedTo,
    recording: changes['recording'] as String? ?? recording,
    controls: changes['controls'] as String? ?? controls,
    extension: extension,
    queueId: changes.containsKey('queueId')
        ? changes['queueId'] as String?
        : queueId,
    parked: changes.containsKey('parked')
        ? ParkedAt.fromJson(changes['parked'])
        : parked,
  );
}

/// A parking lot and slot a call waits in.
class ParkedAt {
  const ParkedAt(this.parkingLotId, this.slot);

  final String parkingLotId;

  /// The number to dial to take the call back.
  final int slot;

  static ParkedAt? fromJson(Object? json) {
    if (json is! Map) return null;
    final lot = json['parkingLotId'];
    final slot = json['slot'];
    return lot is String && slot is int ? ParkedAt(lot, slot) : null;
  }
}

/// A call as the live calls table shows it: the two legs of a bridged call
/// are one row, from the caller to whoever was rung.
class LiveCallRow {
  const LiveCallRow(this.legs);

  /// The caller's leg first.
  final List<LiveCall> legs;

  LiveCall get first => legs.first;
  LiveCall get last => legs.last;
  String get id => first.callUuid;
  String get from => first.from;
  String get to => last.to;
  DateTime get startedAt => first.startedAt;

  /// Held if any leg is held, answered if any is, else ringing.
  String get state => legs.any((l) => l.state == 'held')
      ? 'held'
      : legs.any((l) => l.state == 'answered')
      ? 'answered'
      : 'ringing';

  DateTime? get answeredAt => legs
      .map((l) => l.answeredAt)
      .whereType<DateTime>()
      .fold<DateTime?>(null, (a, b) => a == null || b.isBefore(a) ? b : a);

  /// Whether the call is being recorded (paused or not).
  bool get recording => recordingState != 'off';

  /// `paused` if a leg's recording is paused, `on` if one is recording, else
  /// `off`. The recording runs on one leg of a call (the one that owns it).
  String get recordingState => legs.any((l) => l.recording == 'paused')
      ? 'paused'
      : legs.any((l) => l.recording == 'on')
      ? 'on'
      : 'off';

  /// What the recording buttons can do on the call (both legs say the same;
  /// the first that says anything wins).
  String get controls => legs
      .map((l) => l.controls)
      .firstWhere((c) => c != 'none', orElse: () => 'none');

  /// Where the call waits, when one of its legs is parked.
  ParkedAt? get parked =>
      legs.map((l) => l.parked).whereType<ParkedAt>().firstOrNull;

  /// The queue the call is in, when a queue handles it.
  String? get queueId =>
      legs.map((l) => l.queueId).whereType<String>().firstOrNull;

  /// The leg ringing a phone, when one is: the one a pickup takes.
  LiveCall? get ringingPhone => legs
      .where((l) => l.state == 'ringing' && l.extension != null)
      .firstOrNull;
}

/// What the live calls panel shows: the calls, or why there are none to show.
class LiveCallsView {
  const LiveCallsView({
    this.calls = const [],
    this.stopped,
    this.loaded = false,
  });

  final List<LiveCallRow> calls;

  /// Why the calls are not being received, when they are not (a
  /// [TopicStopped.code]).
  final String? stopped;

  /// A snapshot has arrived since the last (re)subscribe.
  final bool loaded;
}

/// The tenant's live calls, kept from the topic's snapshot and changes.
class LiveCallBook {
  final _legs = <String, LiveCall>{};
  String? _stopped;
  bool _loaded = false;

  LiveCallsView apply(TopicMessage message) {
    switch (message) {
      case TopicSubscribed():
        _stopped = null;
      case TopicSnapshot(:final data):
        _legs
          ..clear()
          ..addEntries([
            for (final json in (data['calls'] as List? ?? const []))
              if (json is Map)
                MapEntry(
                  json['callUuid'] as String,
                  LiveCall.fromJson(json.cast<String, dynamic>()),
                ),
          ]);
        _stopped = null;
        _loaded = true;
      case TopicEvent(:final event):
        _applyEvent(event);
      case TopicStopped(:final code):
        _stopped = code;
        _loaded = false;
    }
    return view();
  }

  void _applyEvent(Map<String, dynamic> event) {
    switch (event['type']) {
      case 'call.started':
        final call = LiveCall.fromJson(
          (event['call'] as Map).cast<String, dynamic>(),
        );
        _legs[call.callUuid] = call;
      case 'call.updated':
        final id = event['callUuid'] as String?;
        final changes = (event['changes'] as Map?)?.cast<String, dynamic>();
        final leg = _legs[id];
        if (leg != null && changes != null) _legs[id!] = leg.apply(changes);
      case 'call.ended':
        _legs.remove(event['callUuid']);
    }
  }

  LiveCallsView view() => LiveCallsView(
    calls: groupLegs(_legs.values),
    stopped: _stopped,
    loaded: _loaded,
  );
}

/// Pairs bridged legs into one row each, oldest call first. A leg bridged to a
/// leg that is not (or no longer) listed stands alone.
List<LiveCallRow> groupLegs(Iterable<LiveCall> legs) {
  final byId = {for (final leg in legs) leg.callUuid: leg};
  // Either leg may be the one that says it is bridged.
  final partner = <String, String>{};
  for (final leg in byId.values) {
    final other = leg.bridgedTo;
    if (other == null || !byId.containsKey(other) || other == leg.callUuid) {
      continue;
    }
    partner.putIfAbsent(leg.callUuid, () => other);
    partner.putIfAbsent(other, () => leg.callUuid);
  }
  final ordered = [...byId.values]
    ..sort((a, b) => a.startedAt.compareTo(b.startedAt));
  final seen = <String>{};
  final rows = <LiveCallRow>[];
  for (final leg in ordered) {
    if (!seen.add(leg.callUuid)) continue;
    final other = byId[partner[leg.callUuid]];
    if (other == null || !seen.add(other.callUuid)) {
      rows.add(LiveCallRow([leg]));
      continue;
    }
    // The caller's leg (the one that called in) first.
    final callerFirst =
        other.direction == 'inbound' && leg.direction != 'inbound';
    rows.add(LiveCallRow(callerFirst ? [other, leg] : [leg, other]));
  }
  return rows;
}

/// The topic name for a tenant's live calls.
String liveCallsTopic(String tenantId) => 'tenant:$tenantId:calls';

/// The topic name for the live calls one person may monitor (G-119 (1)): the
/// gateway's `user:{u}:supervised`, in the same shape as [liveCallsTopic].
String supervisedCallsTopic(String tenantId, String userId) =>
    'tenant:$tenantId:user:$userId:supervised';

/// Whether the viewer sees only the calls they may monitor: they may listen,
/// whisper or barge (perhaps only on some extensions or queues) but do not
/// hold `monitor.calls`, which shows all of the tenant's.
final supervisesOnlyProvider = Provider<bool>(
  (ref) => !ref.watch(canProvider('monitor.calls')),
);

/// The live calls of the tenant being looked at, from the realtime hub: all of
/// them for a holder of `monitor.calls`, else the ones the viewer may monitor.
/// Only watched while a screen shows them: leaving the screen unsubscribes.
final liveCallsProvider = StreamProvider.autoDispose<LiveCallsView>((ref) {
  final tenant = ref.watch(tenantIdProvider);
  final client = ref.watch(realtimeClientProvider);
  if (tenant == null || client == null) return const Stream.empty();
  final userId = ref.watch(sessionProvider)?.userId ?? '';
  final topic = ref.watch(supervisesOnlyProvider)
      ? supervisedCallsTopic(tenant, userId)
      : liveCallsTopic(tenant);
  final book = LiveCallBook();
  return client.watch(topic).map(book.apply);
});

/// The time now, once a second, so call durations count up. Tests fix it.
final clockProvider = StreamProvider.autoDispose<DateTime>(
  (ref) => Stream.periodic(const Duration(seconds: 1), (_) => DateTime.now()),
);
