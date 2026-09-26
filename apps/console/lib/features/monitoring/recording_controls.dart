import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/problem.dart';
import '../../core/session.dart';

/// The recording actions on a live call: the buttons' `action`.
enum RecordingAction {
  start('start', 'Record', 'Starting…', Icons.fiber_manual_record),
  stop('stop', 'Stop', 'Stopping…', Icons.stop),
  pause('pause', 'Pause', 'Pausing…', Icons.pause),
  resume('resume', 'Resume', 'Resuming…', Icons.play_arrow);

  const RecordingAction(this.wire, this.label, this.pendingLabel, this.icon);

  final String wire;
  final String label;
  final String pendingLabel;
  final IconData icon;
}

/// Which buttons a call offers, from what it allows (`controls`) and what its
/// recording is doing now (`recording`). The same rules as the in-call feature
/// codes `*1` and `*2`, which the service applies again on every press:
///
/// - `on_demand` (the rule does not record, but allows on demand): Record when
///   not recording; Stop and Pause while recording; Stop and Resume while
///   paused.
/// - `pause` (the rule records and allows on demand): Pause while recording,
///   Resume while paused. A recording a rule started is never stopped.
/// - anything else: nothing.
List<RecordingAction> recordingActionsFor(String controls, String recording) {
  switch (controls) {
    case 'on_demand':
      return switch (recording) {
        'on' => const [RecordingAction.stop, RecordingAction.pause],
        'paused' => const [RecordingAction.stop, RecordingAction.resume],
        _ => const [RecordingAction.start],
      };
    case 'pause':
      return switch (recording) {
        'on' => const [RecordingAction.pause],
        'paused' => const [RecordingAction.resume],
        _ => const [],
      };
    default:
      return const [];
  }
}

/// `POST .../calls/{callUuid}/recording` (a supervisor or administrator, any
/// call of the tenant) and `POST .../me/live-calls/{callUuid}/recording` (a
/// person, their own call). The service decides and records every action
/// before it happens; the live feed then shows the result.
class RecordingControlApi {
  RecordingControlApi(this._dio, this._token);

  final Dio _dio;
  final String _token;

  Future<void> act({
    required String tenantId,
    required String callUuid,
    required RecordingAction action,
    required bool mine,
  }) async {
    final path = mine
        ? '/v1/tenants/$tenantId/me/live-calls/$callUuid/recording'
        : '/v1/tenants/$tenantId/calls/$callUuid/recording';
    await _dio.post<Object?>(
      path,
      data: {'action': action.wire},
      options: Options(headers: {'Authorization': 'Bearer $_token'}),
    );
  }
}

final recordingControlApiProvider = Provider<RecordingControlApi?>((ref) {
  final session = ref.watch(sessionProvider);
  if (session == null) return null;
  return RecordingControlApi(ref.watch(apiProvider).dio, session.accessToken);
});

/// A press still waiting for the live feed to show its result.
class PendingRecording {
  const PendingRecording(this.action, this.from);

  final RecordingAction action;

  /// The call's recording state when the button was pressed.
  final String from;
}

/// The presses waiting for the live feed, by call. A press is shown as pending
/// (never as done) until the feed shows the call's recording in another state
/// than it was in when pressed, or the request fails, or a while passes with
/// no change: the screen never claims a state the call is not in.
class PendingRecordings extends Notifier<Map<String, PendingRecording>> {
  final _timers = <String, Timer>{};

  /// How long a press waits for the feed before its buttons come back.
  static const patience = Duration(seconds: 15);

  @override
  Map<String, PendingRecording> build() {
    ref.onDispose(() {
      for (final timer in _timers.values) {
        timer.cancel();
      }
    });
    return const {};
  }

  void start(String callId, PendingRecording pending) {
    _timers.remove(callId)?.cancel();
    _timers[callId] = Timer(patience, () => clear(callId));
    state = {...state, callId: pending};
  }

  void clear(String callId) {
    _timers.remove(callId)?.cancel();
    if (!state.containsKey(callId)) return;
    state = {...state}..remove(callId);
  }
}

final pendingRecordingsProvider =
    NotifierProvider<PendingRecordings, Map<String, PendingRecording>>(
      PendingRecordings.new,
    );

/// The recording buttons for one live call: those [recordingActionsFor] allows,
/// or, while a press waits for the live feed, what it is doing. A failure is
/// said in a snackbar, in the service's own (neutral) words.
class RecordingControls extends ConsumerWidget {
  const RecordingControls({
    super.key,
    required this.tenantId,
    required this.callId,
    required this.actOn,
    required this.recording,
    required this.controls,
    this.mine = false,
  });

  final String tenantId;

  /// The call, as the screen keys it (the pending press is kept under it).
  final String callId;

  /// The leg to name in the request. The service finds the call's recording
  /// from it, whichever leg it is (for [mine], it must be the person's own).
  final String actOn;

  final String recording;
  final String controls;
  final bool mine;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pending = ref.watch(pendingRecordingsProvider)[callId];
    if (pending != null && pending.from == recording) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(
            width: 14,
            height: 14,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: 8),
          Text(pending.action.pendingLabel),
        ],
      );
    }
    final actions = recordingActionsFor(controls, recording);
    if (actions.isEmpty) return const SizedBox.shrink();
    // One line: a table cell is one row high.
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final action in actions)
          TextButton.icon(
            key: ValueKey('recording-${action.wire}-$callId'),
            onPressed: () => _press(context, ref, action),
            icon: Icon(action.icon, size: 18),
            label: Text(action.label),
          ),
      ],
    );
  }

  Future<void> _press(
    BuildContext context,
    WidgetRef ref,
    RecordingAction action,
  ) async {
    final api = ref.read(recordingControlApiProvider);
    if (api == null) return;
    final pending = ref.read(pendingRecordingsProvider.notifier);
    final messenger = ScaffoldMessenger.of(context);
    pending.start(callId, PendingRecording(action, recording));
    try {
      await api.act(
        tenantId: tenantId,
        callUuid: actOn,
        action: action,
        mine: mine,
      );
    } catch (e) {
      pending.clear(callId);
      messenger.showSnackBar(SnackBar(content: Text(problemMessage(e))));
    }
  }
}

/// How a call's recording reads in a table or a card.
String recordingLabel(String state) => switch (state) {
  'on' => 'Recording',
  'paused' => 'Paused',
  _ => '—',
};
