import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../core/session.dart';
import '../pbx/pbx_api.dart';
import '../../widgets/page.dart';
import 'live_calls.dart';
import 'monitor_controls.dart';
import 'presence_board.dart';
import 'recording_controls.dart';
import '../../core/format.dart';

/// Monitoring (08 §5): the presence board and the tenant's live calls, both
/// streamed from the gateway's realtime hub, with the recording buttons
/// (S5-15) and the listen, whisper and barge buttons (S5-10).
class MonitoringPage extends ConsumerWidget {
  const MonitoringPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final title = Theme.of(context).textTheme.titleMedium;
    final showsCalls = ref.watch(showsLiveCallsProvider);
    final supervised = ref.watch(supervisesOnlyProvider);
    return PageFrame(
      children: [
        const PageHeader(
          title: 'Monitoring',
          subtitle: 'What is happening on the phones right now.',
        ),
        const SizedBox(height: 16),
        Text('Presence', style: title),
        const SizedBox(height: 8),
        // The board takes what it needs, up to a third of the height when the
        // calls table is below it, and scrolls beyond that.
        const Flexible(child: PresencePanel()),
        const SizedBox(height: 24),
        Text(supervised ? 'Calls you can monitor' : 'Live calls', style: title),
        const SizedBox(height: 8),
        if (showsCalls)
          const Expanded(flex: 2, child: LiveCallsPanel())
        else
          const LiveCallsPanel(),
      ],
    );
  }
}

/// Whether the viewer is shown live calls: `private` tenant data, so never a
/// reseller (rule H1). A holder of `monitor.calls` sees all of the tenant's;
/// someone who may listen, whisper or barge (perhaps only on some extensions or
/// queues, G-119 (1)) sees the calls they may monitor.
final showsLiveCallsProvider = Provider<bool>(
  (ref) =>
      ref.watch(sessionProvider)?.orgType != OrgType.reseller &&
      (ref.watch(canProvider('monitor.calls')) ||
          MonitorMode.values.any(
            (mode) => ref.watch(canProvider(mode.permission)),
          )),
);

/// The tenant's calls in progress (or, without `monitor.calls`, the ones the
/// viewer may monitor), updated as they change. Live calls are `private` tenant
/// data: a reseller never sees them (rule H1). Hiding is a convenience; the
/// gateway refuses the subscription regardless.
class LiveCallsPanel extends ConsumerWidget {
  const LiveCallsPanel({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    if (ref.watch(tenantIdProvider) == null) {
      return const Text('Choose a tenant to see its live calls.');
    }
    if (!ref.watch(showsLiveCallsProvider)) {
      return const Text("Your role doesn't include live calls.");
    }
    final view = ref.watch(liveCallsProvider).value;
    final stopped = view?.stopped;
    if (view == null || (!view.loaded && stopped == null)) {
      return const Text('Connecting…');
    }
    if (stopped != null) return Text(_stoppedText(stopped));
    if (view.calls.isEmpty) return const Text('No calls right now.');
    return _LiveCallsTable(
      rows: view.calls,
      tenantId: ref.watch(tenantIdProvider)!,
      // The recording buttons (S5-15): `recording.control`, private, so never
      // a reseller's. Hiding is a convenience; the service refuses regardless.
      canControl:
          session?.orgType != OrgType.reseller &&
          ref.watch(canProvider('recording.control')),
      // Listen, whisper and barge (S5-10): each its own permission, private,
      // so never a reseller's. `/me` lists a permission held only as a grant
      // on an extension or a queue as well: the service refuses a call
      // outside that grant (a snackbar), which the console cannot tell apart.
      monitorModes: [
        if (session?.orgType != OrgType.reseller)
          for (final mode in MonitorMode.values)
            if (ref.watch(canProvider(mode.permission))) mode,
      ],
    );
  }
}

String _stoppedText(String code) => switch (code) {
  'offline' || 'unavailable' => 'Live updates are unavailable. Reconnecting…',
  'forbidden' ||
  'permission_denied' ||
  'reseller_private_data_denied' => "Your role doesn't include live calls.",
  _ => 'Live updates stopped.',
};

const _stateLabels = {
  'ringing': 'Ringing',
  'answered': 'Talking',
  'held': 'On hold',
};

/// Minutes and seconds (hours when there are any) from [since] to [now].
String liveDuration(DateTime since, DateTime now) =>
    formatClock(now.difference(since).inSeconds);

class _LiveCallsTable extends ConsumerWidget {
  const _LiveCallsTable({
    required this.rows,
    required this.tenantId,
    required this.canControl,
    required this.monitorModes,
  });

  final List<LiveCallRow> rows;
  final String tenantId;

  /// Whether the viewer may press the recording buttons (`recording.control`).
  final bool canControl;

  /// The monitor buttons the viewer may press (`monitor.listen`, ...).
  final List<MonitorMode> monitorModes;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    final actions = canControl || monitorModes.isNotEmpty;
    return SingleChildScrollView(
      child: SingleChildScrollView(
        // The buttons make a row wider than a narrow window.
        scrollDirection: Axis.horizontal,
        child: DataTable(
          columns: [
            const DataColumn(label: Text('From')),
            const DataColumn(label: Text('To')),
            const DataColumn(label: Text('State')),
            const DataColumn(label: Text('Duration')),
            const DataColumn(label: Text('Recording')),
            if (actions) const DataColumn(label: Text('Actions')),
          ],
          rows: [
            for (final row in rows)
              DataRow(
                key: ValueKey(row.id),
                cells: [
                  DataCell(Text(row.from.isEmpty ? '—' : row.from)),
                  DataCell(Text(row.to.isEmpty ? '—' : row.to)),
                  DataCell(Text(_stateLabels[row.state] ?? row.state)),
                  // Talking time once answered; until then, how long it has rung.
                  DataCell(
                    Text(liveDuration(row.answeredAt ?? row.startedAt, now)),
                  ),
                  DataCell(Text(recordingLabel(row.recordingState))),
                  if (actions)
                    DataCell(
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          // A ringing call cannot be joined yet.
                          if (monitorable(row.state))
                            MonitorControls(
                              tenantId: tenantId,
                              callId: row.id,
                              actOn: row.first.callUuid,
                              modes: monitorModes,
                            ),
                          if (canControl)
                            RecordingControls(
                              tenantId: tenantId,
                              callId: row.id,
                              actOn: row.first.callUuid,
                              recording: row.recordingState,
                              controls: row.controls,
                            ),
                        ],
                      ),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}
