import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/l10n.dart';
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
    final l = context.l10n;
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
                label: l.opsServicesReady,
                value: l.opsPartOfWhole(
                  '${o.servicesReady}',
                  '${o.services.length}',
                ),
                icon: Icons.dns_outlined,
                health: servicesAllReady ? Health.good : Health.attention,
                detail: servicesAllReady
                    ? l.opsAllReportingReady
                    : l.opsNeedAttention(o.services.length - o.servicesReady),
              ),
              StatTile(
                label: l.opsMediaNodesInService,
                value: l.opsPartOfWhole(
                  '${o.nodesInService}',
                  '${o.nodes.length}',
                ),
                icon: Icons.graphic_eq,
                health: o.nodes.isEmpty
                    ? Health.neutral
                    : o.nodesInService == 0
                    ? Health.bad
                    : nodesAllIn
                    ? Health.good
                    : Health.attention,
                detail: nodesAllIn
                    ? l.opsTakingNewCalls
                    : l.opsNotTakingNewCalls(o.nodes.length - o.nodesInService),
              ),
              StatTile(
                label: l.monLiveCalls,
                value: formatCount(o.liveCalls),
                icon: Icons.call_outlined,
                detail: l.opsOnEveryMediaNode,
              ),
              StatTile(
                label: l.opsRegisteredPhones,
                value: formatCount(o.signalling?.registrations),
                icon: Icons.phone_android_outlined,
                detail: o.signalling == null
                    ? l.opsEdgeNotAnswering
                    : l.opsCallsAtTheEdge(
                        formatCount(o.signalling!.activeDialogs),
                      ),
              ),
              StatTile(
                label: l.opsEventBacklog,
                value: formatCount(events?.backlog),
                icon: Icons.move_to_inbox_outlined,
                health: events == null
                    ? Health.bad
                    : events.backlog == 0
                    ? Health.good
                    : Health.attention,
                detail: events == null
                    ? l.opsEventBusNotAnswering
                    : behind.isEmpty
                    ? l.opsEveryConsumerCaughtUp
                    : l.opsConsumersBehind(behind.length),
              ),
            ],
          ),
          const SizedBox(height: 16),
          ResponsiveGrid(
            minWidth: 420,
            maxColumns: 2,
            children: [
              Panel(
                title: l.opsCallsPerMediaNode,
                subtitle: l.opsCallsPerMediaNodeHelp,
                child: ValueBarChart(
                  items: [
                    for (final n in o.nodes) (n.nodeId, n.calls.toDouble()),
                  ],
                  format: (v) => formatCount(v),
                  emptyText: l.opsNoMediaNodes,
                ),
              ),
              Panel(
                title: l.opsMediaNodeCpu,
                subtitle: l.opsMediaNodeCpuHelp,
                child: SizedBox(
                  height: 220,
                  child: o.nodes.isEmpty
                      ? Center(child: Text(l.opsNoMediaNodes))
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
                title: l.opsLiveCallsTrend,
                subtitle: l.opsLiveCallsTrendHelp,
                child: TrendChart(
                  points: [for (final s in history) (s.at, s.calls.toDouble())],
                  format: (v) => formatCount(v),
                ),
              ),
              Panel(
                title: l.opsEventBacklogTrend,
                subtitle: l.opsEventBacklogTrendHelp,
                child: TrendChart(
                  points: [
                    for (final s in history)
                      if (s.backlog != null) (s.at, s.backlog!.toDouble()),
                  ],
                  format: (v) => formatCount(v),
                ),
              ),
              Panel(
                title: l.opsResponseTimes,
                subtitle: unreachable == 0
                    ? l.opsResponseTimesHelp
                    : l.opsResponseTimesSomeDown(unreachable),
                child: ValueBarChart(
                  items: [for (final s in reachable) (s.name, s.latencyMs!)],
                  format: (v) => formatMs(v),
                  floor: 20,
                  emptyText: l.opsNoServiceAnswered,
                ),
              ),
              Panel(
                title: l.opsBacklogByConsumer,
                subtitle: events == null
                    ? l.opsEventBusDown
                    : behind.isEmpty
                    ? l.opsEveryConsumerIsCaughtUp
                    : l.opsConsumersFurthestBehind,
                child: ValueBarChart(
                  items: [
                    for (final c in (behind.isEmpty ? consumers : behind).take(
                      8,
                    ))
                      (c.name, c.backlog.toDouble()),
                  ],
                  format: (v) => formatCount(v),
                  emptyText: events == null
                      ? l.opsEventBusNotAnsweringShort
                      : l.opsNoConsumersYet,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
