import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/permissions.dart';
import '../../core/realtime.dart';
import '../../l10n/l10n.dart';
import '../../widgets/feedback.dart';
import '../attendant/attendant_api.dart';
import '../pbx/pbx_api.dart';
import 'live_calls.dart' show clockProvider;

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

/// The queues (S9-13): how many wait and for how long, and each agent. A holder
/// of `queue.agent.manage` (S9-20) can sign an agent in, out or on a break from
/// here; held on one queue only, the service refuses the other queues' agents. Shown
/// on the attendant console and on Monitoring (S9-15).
class QueuesPanel extends ConsumerWidget {
  const QueuesPanel({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    if (!ref.watch(canProvider('queue.read'))) return const SizedBox.shrink();
    final queues = ref.watch(liveQueuesProvider).value;
    if (queues == null || queues.isEmpty) return const SizedBox.shrink();
    final labels = {
      for (final q
          in ref.watch(rowsProvider('queues')).asData?.value ?? const <Json>[])
        '${q['id']}': '${q['label']}',
    };
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final queue in queues)
          Card(
            key: ValueKey('attendant-queue-${queue.queueId}'),
            margin: EdgeInsets.zero,
            child: Padding(
              padding: const EdgeInsets.all(10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    labels[queue.queueId] ?? queue.queueId,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  Text(
                    queue.longestWaitingSince == null
                        ? l10n.attQueueWaiting(queue.waiting)
                        : l10n.attQueueWaitingLongest(
                            queue.waiting,
                            formatClock(
                              now
                                  .difference(queue.longestWaitingSince!)
                                  .inSeconds
                                  .clamp(0, 1 << 30),
                            ),
                          ),
                  ),
                  Wrap(
                    spacing: 4,
                    children: [
                      for (final agent in queue.agents)
                        _AgentChip(agent: agent),
                    ],
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _AgentChip extends ConsumerWidget {
  const _AgentChip({required this.agent});

  final LiveAgent agent;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final label = switch (agent.status) {
      'available' => l10n.attAgentAvailable,
      'on_break' => l10n.attAgentOnBreak,
      'logged_out' => l10n.attAgentSignedOut,
      _ => l10n.presenceUnknown,
    };
    final chip = Chip(label: Text('${agent.extension} · $label'));
    // Signing an agent in or out is `queue.agent.manage`'s (S9-20); others only see.
    if (!ref.watch(canProvider('queue.agent.manage'))) {
      return KeyedSubtree(
        key: ValueKey('attendant-agent-${agent.extension}'),
        child: chip,
      );
    }
    return PopupMenuButton<String>(
      key: ValueKey('attendant-agent-${agent.extension}'),
      tooltip: l10n.attAgentChange,
      onSelected: (status) async {
        final messenger = ScaffoldMessenger.of(context);
        try {
          await ref
              .read(attendantApiProvider)
              ?.setAgentStatus(agent.extension, status);
        } catch (e) {
          showToast(messenger, problemMessage(e));
        }
      },
      itemBuilder: (_) => [
        PopupMenuItem(value: 'available', child: Text(l10n.attAgentSignIn)),
        PopupMenuItem(value: 'on_break', child: Text(l10n.attAgentBreak)),
        PopupMenuItem(value: 'logged_out', child: Text(l10n.attAgentSignOut)),
      ],
      child: chip,
    );
  }
}
