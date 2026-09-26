import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../core/realtime.dart';
import '../../core/session.dart';
import '../monitoring/live_calls.dart';
import '../monitoring/monitoring_page.dart' show liveDuration;
import '../monitoring/recording_controls.dart';
import 'my_phone_api.dart';

/// The topic of a person's own live calls (the gateway's `user:{u}:calls`):
/// the legs on their own extension and the legs bridged to them, for them
/// alone.
String myLiveCallsTopic(String tenantId, String userId) =>
    'tenant:$tenantId:user:$userId:calls';

/// My calls in progress, from the realtime hub, while a My phone screen shows
/// them. Nothing names my extension: the gateway works it out from who signed
/// in, as every self-service route does.
final myLiveCallsProvider = StreamProvider.autoDispose<LiveCallsView>((ref) {
  final api = ref.watch(myPhoneApiProvider);
  final userId = ref.watch(sessionProvider.select((s) => s?.userId));
  final client = ref.watch(realtimeClientProvider);
  final held = ref.watch(knownPermissionsProvider);
  if (api == null || userId == null || userId.isEmpty || client == null) {
    return const Stream.empty();
  }
  // My own calls are my call history as it happens: `self.history`.
  if (held != null && !holds(held, 'self.history')) return const Stream.empty();
  final book = LiveCallBook();
  return client.watch(myLiveCallsTopic(api.tenantId, userId)).map(book.apply);
});

/// A card per call I am on, with its recording and, where the call's rules
/// allow it and I hold `self.recording`, the same record, stop, pause and
/// resume buttons as the phone's `*1` and `*2`. Shows nothing when I am on no
/// call, or when live updates are not available: it is an addition to My
/// phone, never in the way of it.
class MyLiveCalls extends ConsumerWidget {
  const MyLiveCalls({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final view = ref.watch(myLiveCallsProvider).value;
    if (view == null || !view.loaded || view.calls.isEmpty) {
      return const SizedBox.shrink();
    }
    final myNumber = ref.watch(myExtensionProvider).value?['number'] as String?;
    final api = ref.watch(myPhoneApiProvider);
    final canControl = ref.watch(canProvider('self.recording'));
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final row in view.calls)
            _MyCallCard(
              key: ValueKey('my-live-call-${row.id}'),
              row: row,
              myNumber: myNumber,
              tenantId: api?.tenantId ?? '',
              canControl: canControl && api != null,
              now: now,
            ),
        ],
      ),
    );
  }
}

class _MyCallCard extends StatelessWidget {
  const _MyCallCard({
    super.key,
    required this.row,
    required this.myNumber,
    required this.tenantId,
    required this.canControl,
    required this.now,
  });

  final LiveCallRow row;
  final String? myNumber;
  final String tenantId;
  final bool canControl;
  final DateTime now;

  /// My own leg of the call: the one on my extension. The buttons name it (the
  /// service accepts only my own leg from me).
  LiveCall get _mine => row.legs.firstWhere(
    (l) => l.extension != null && l.extension == myNumber,
    orElse: () => row.legs.firstWhere(
      (l) => l.extension != null,
      orElse: () => row.first,
    ),
  );

  @override
  Widget build(BuildContext context) {
    final mine = _mine;
    // A leg that called in is mine calling out; one the system placed rang me.
    final other = mine.direction == 'inbound' ? mine.to : mine.from;
    final state = switch (row.state) {
      'ringing' => 'Ringing',
      'held' => 'On hold',
      _ => 'On a call',
    };
    final recording = row.recordingState;
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 16,
          runSpacing: 8,
          children: [
            const Icon(Icons.phone_in_talk_outlined),
            Text(
              '$state with ${other.isEmpty ? 'an unknown number' : other}',
              style: Theme.of(context).textTheme.titleSmall,
            ),
            Text(liveDuration(row.answeredAt ?? row.startedAt, now)),
            if (recording != 'off')
              Chip(
                avatar: Icon(
                  recording == 'paused'
                      ? Icons.pause_circle_outline
                      : Icons.fiber_manual_record,
                  size: 16,
                ),
                label: Text(
                  recording == 'paused' ? 'Recording paused' : 'Recording',
                ),
              ),
            if (canControl)
              RecordingControls(
                tenantId: tenantId,
                callId: row.id,
                actOn: mine.callUuid,
                recording: recording,
                controls: row.controls,
                mine: true,
              ),
          ],
        ),
      ),
    );
  }
}
