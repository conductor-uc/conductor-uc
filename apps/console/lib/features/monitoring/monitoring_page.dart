import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../core/session.dart';
import '../pbx/pbx_api.dart';
import '../../widgets/page.dart';
import 'live_calls.dart';

/// Monitoring (08 §5). For now: the tenant's live calls, streamed from the
/// gateway's realtime hub. The presence board and the listen, whisper and
/// barge actions come with S5-09/S5-10.
class MonitoringPage extends ConsumerWidget {
  const MonitoringPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return PageFrame(
      children: [
        const PageHeader(
          title: 'Monitoring',
          subtitle: 'What is happening on the phones right now.',
        ),
        const SizedBox(height: 16),
        Text('Live calls', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        const Expanded(child: LiveCallsPanel()),
      ],
    );
  }
}

/// The tenant's calls in progress, updated as they change. Live calls are
/// `private` tenant data: a reseller never sees them (rule H1), and anyone else
/// needs `monitor.calls`. Hiding is a convenience; the gateway refuses the
/// subscription regardless.
class LiveCallsPanel extends ConsumerWidget {
  const LiveCallsPanel({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    if (ref.watch(tenantIdProvider) == null) {
      return const Text('Choose a tenant to see its live calls.');
    }
    if (session?.orgType == OrgType.reseller ||
        !ref.watch(canProvider('monitor.calls'))) {
      return const Text("Your role doesn't include live calls.");
    }
    final view = ref.watch(liveCallsProvider).value;
    final stopped = view?.stopped;
    if (view == null || (!view.loaded && stopped == null)) {
      return const Text('Connecting…');
    }
    if (stopped != null) return Text(_stoppedText(stopped));
    if (view.calls.isEmpty) return const Text('No calls right now.');
    return _LiveCallsTable(rows: view.calls);
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

String _two(int n) => n.toString().padLeft(2, '0');

/// Minutes and seconds (hours when there are any) from [since] to [now].
String liveDuration(DateTime since, DateTime now) {
  final s = now.difference(since).inSeconds.clamp(0, 1 << 31);
  final h = s ~/ 3600;
  final m = (s % 3600) ~/ 60;
  return h > 0 ? '$h:${_two(m)}:${_two(s % 60)}' : '$m:${_two(s % 60)}';
}

class _LiveCallsTable extends ConsumerWidget {
  const _LiveCallsTable({required this.rows});

  final List<LiveCallRow> rows;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    return SingleChildScrollView(
      child: DataTable(
        columns: const [
          DataColumn(label: Text('From')),
          DataColumn(label: Text('To')),
          DataColumn(label: Text('State')),
          DataColumn(label: Text('Duration')),
          DataColumn(label: Text('Recording')),
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
                DataCell(Text(row.recording ? 'Recording' : '—')),
              ],
            ),
        ],
      ),
    );
  }
}
