import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'operations_api.dart';
import 'operations_charts.dart';
import 'operations_widgets.dart';

/// The Overview tab: headline figures, then the charts.
class OverviewTab extends ConsumerWidget {
  const OverviewTab({super.key, required this.overview});

  final Overview overview;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final history = ref.watch(operationsHistoryProvider);
    final o = overview;
    final events = o.events;
    final servicesAllReady = o.servicesReady == o.services.length;
    final nodesAllIn = o.nodesInService == o.nodes.length;

    final reachable = [
      for (final s in o.services)
        if (s.status != 'down' && s.latencyMs != null) s,
    ]..sort((a, b) => b.latencyMs!.compareTo(a.latencyMs!));
    final unreachable = o.services.length - reachable.length;

    final consumers = [...?events?.consumers]
      ..sort((a, b) => b.backlog.compareTo(a.backlog));
    final behind = consumers.where((c) => c.backlog > 0).toList();

    return SingleChildScrollView(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ResponsiveGrid(
            minWidth: 200,
            maxColumns: 5,
            children: [
              StatTile(
                label: 'Services ready',
                value: '${o.servicesReady} of ${o.services.length}',
                icon: Icons.dns_outlined,
                health: servicesAllReady ? Health.good : Health.attention,
                detail: servicesAllReady
                    ? 'All reporting ready'
                    : '${o.services.length - o.servicesReady} need attention',
              ),
              StatTile(
                label: 'Media nodes in service',
                value: '${o.nodesInService} of ${o.nodes.length}',
                icon: Icons.graphic_eq,
                health: o.nodes.isEmpty
                    ? Health.neutral
                    : o.nodesInService == 0
                    ? Health.bad
                    : nodesAllIn
                    ? Health.good
                    : Health.attention,
                detail: nodesAllIn
                    ? 'Taking new calls'
                    : '${o.nodes.length - o.nodesInService} not taking new calls',
              ),
              StatTile(
                label: 'Live calls',
                value: formatCount(o.liveCalls),
                icon: Icons.call_outlined,
                detail: 'On every media node',
              ),
              StatTile(
                label: 'Registered phones',
                value: formatCount(o.signalling?.registrations),
                icon: Icons.phone_android_outlined,
                detail: o.signalling == null
                    ? 'Edge not answering'
                    : '${formatCount(o.signalling!.activeDialogs)} calls at the edge',
              ),
              StatTile(
                label: 'Event backlog',
                value: formatCount(events?.backlog),
                icon: Icons.move_to_inbox_outlined,
                health: events == null
                    ? Health.bad
                    : events.backlog == 0
                    ? Health.good
                    : Health.attention,
                detail: events == null
                    ? 'Event bus not answering'
                    : behind.isEmpty
                    ? 'Every consumer caught up'
                    : '${behind.length} consumers behind',
              ),
            ],
          ),
          const SizedBox(height: 16),
          ResponsiveGrid(
            minWidth: 420,
            maxColumns: 2,
            children: [
              Panel(
                title: 'Calls per media node',
                subtitle: 'Live calls on each node now.',
                child: ValueBarChart(
                  items: [
                    for (final n in o.nodes) (n.nodeId, n.calls.toDouble()),
                  ],
                  format: (v) => formatCount(v),
                  emptyText: 'No media nodes are configured.',
                ),
              ),
              Panel(
                title: 'Media node CPU',
                subtitle:
                    'How busy each node reported itself at its last heartbeat.',
                child: SizedBox(
                  height: 220,
                  child: o.nodes.isEmpty
                      ? const Center(
                          child: Text('No media nodes are configured.'),
                        )
                      : Center(
                          child: SingleChildScrollView(
                            child: Wrap(
                              spacing: 24,
                              runSpacing: 16,
                              alignment: WrapAlignment.center,
                              children: [
                                for (final n in o.nodes)
                                  CpuGauge(
                                    label: n.nodeId,
                                    busyPercent: n.cpuBusyPercent,
                                  ),
                              ],
                            ),
                          ),
                        ),
                ),
              ),
              Panel(
                title: 'Live calls, last 10 minutes',
                subtitle: 'From this page\'s own readings while it is open.',
                child: TrendChart(
                  points: [for (final s in history) (s.at, s.calls.toDouble())],
                  format: (v) => formatCount(v),
                ),
              ),
              Panel(
                title: 'Event backlog, last 10 minutes',
                subtitle: 'Events waiting for a consumer, summed.',
                child: TrendChart(
                  points: [
                    for (final s in history)
                      if (s.backlog != null) (s.at, s.backlog!.toDouble()),
                  ],
                  format: (v) => formatCount(v),
                ),
              ),
              Panel(
                title: 'Service response times',
                subtitle: unreachable == 0
                    ? 'How long each service took to answer this reading.'
                    : 'How long each service took to answer. '
                          '$unreachable not answering (see Services).',
                child: ValueBarChart(
                  items: [for (final s in reachable) (s.name, s.latencyMs!)],
                  format: (v) => formatMs(v),
                  floor: 20,
                  emptyText: 'No service answered.',
                ),
              ),
              Panel(
                title: 'Event backlog by consumer',
                subtitle: events == null
                    ? 'The event bus is not answering.'
                    : behind.isEmpty
                    ? 'Every consumer is caught up.'
                    : 'The consumers furthest behind.',
                child: ValueBarChart(
                  items: [
                    for (final c in (behind.isEmpty ? consumers : behind).take(
                      8,
                    ))
                      (c.name, c.backlog.toDouble()),
                  ],
                  format: (v) => formatCount(v),
                  emptyText: events == null
                      ? 'Event bus not answering.'
                      : 'No consumers yet.',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
