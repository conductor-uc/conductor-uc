import 'package:flutter/material.dart';

import '../../l10n/l10n.dart';
import 'operations_api.dart';
import 'operations_charts.dart';
import 'operations_widgets.dart';

/// A table that scrolls sideways when the window is narrower than it.
class _WideTable extends StatelessWidget {
  const _WideTable({required this.columns, required this.rows});

  final List<String> columns;
  final List<DataRow> rows;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: ConstrainedBox(
        constraints: BoxConstraints(minWidth: constraints.maxWidth),
        child: DataTable(
          headingTextStyle: Theme.of(context).textTheme.labelLarge,
          columnSpacing: 24,
          columns: [for (final c in columns) DataColumn(label: Text(c))],
          rows: rows,
        ),
      ),
    ),
  );
}

/// The Services tab: every service with what it says about itself.
class ServicesTab extends StatelessWidget {
  const ServicesTab({super.key, required this.overview});

  final Overview overview;

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    if (overview.services.isEmpty) {
      return Center(child: Text(l.opsNoServices));
    }
    final services = [...overview.services]
      ..sort((a, b) {
        // Problems first, then by name.
        int rank(ServiceStatus s) => switch (s.status) {
          'down' => 0,
          'degraded' => 1,
          _ => 2,
        };
        final byRank = rank(a).compareTo(rank(b));
        return byRank != 0 ? byRank : a.name.compareTo(b.name);
      });
    return SingleChildScrollView(
      padding: const EdgeInsets.only(bottom: 24),
      child: Card(
        margin: EdgeInsets.zero,
        child: _WideTable(
          columns: [
            l.opsColService,
            l.opsColStatus,
            l.opsColResponse,
            l.opsColVersion,
            l.opsUptime,
            l.opsColMemory,
            l.opsColOutbox,
            l.opsColNotReady,
            l.opsColDetails,
          ],
          rows: [
            for (final s in services)
              DataRow(
                cells: [
                  DataCell(Text(s.name)),
                  DataCell(() {
                    final (health, label) = serviceHealth(s.status);
                    return HealthLabel(health, label, dense: true);
                  }()),
                  DataCell(
                    Text(s.status == 'down' ? noValue : formatMs(s.latencyMs)),
                  ),
                  DataCell(Text(s.version ?? noValue)),
                  DataCell(Text(formatSpan(s.uptimeSeconds))),
                  DataCell(Text(formatBytes(s.rssBytes))),
                  DataCell(_outbox(l, s)),
                  DataCell(
                    Text(
                      s.failingChecks.isEmpty
                          ? noValue
                          : s.failingChecks.join(', '),
                    ),
                  ),
                  DataCell(
                    Text(
                      s.facts.isEmpty
                          ? noValue
                          : [
                              for (final f in s.facts)
                                '${f.label} ${formatFact(f.value, f.unit)}',
                            ].join('  ·  '),
                    ),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  Widget _outbox(AppLocalizations l, ServiceStatus s) {
    if (s.outboxPending == null) return Text(noValue);
    final failed = s.outboxFailed ?? 0;
    final pending = s.outboxPending!;
    final text = pending == 0
        ? l.opsOutboxEmpty
        : l.opsOutboxWaiting(
            formatCount(pending),
            formatSpan(s.outboxOldestSeconds),
          );
    if (failed == 0) return Text(text);
    return HealthLabel(
      Health.bad,
      l.opsOutboxGivenUp(text, formatCount(failed)),
      dense: true,
    );
  }
}

/// The Signalling tab: the SIP edge's own figures and the dispatcher list.
class SignallingTab extends StatelessWidget {
  const SignallingTab({super.key, required this.overview});

  final Overview overview;

  @override
  Widget build(BuildContext context) {
    final s = overview.signalling;
    final theme = Theme.of(context);
    final l = context.l10n;
    final shmShare =
        s?.shmUsedBytes != null &&
            s?.shmTotalBytes != null &&
            s!.shmTotalBytes! > 0
        ? s.shmUsedBytes! / s.shmTotalBytes!
        : null;
    return SingleChildScrollView(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (s == null)
            Card(margin: EdgeInsets.zero, child: Unavailable(l.opsSipEdgeDown))
          else
            ResponsiveGrid(
              minWidth: 200,
              maxColumns: 6,
              children: [
                StatTile(
                  label: l.opsEdge,
                  value: serviceHealth(s.status).$2,
                  icon: Icons.router_outlined,
                  health: serviceHealth(s.status).$1,
                  detail: l.opsUpFor(formatSpan(s.uptimeSeconds)),
                ),
                StatTile(
                  label: l.opsRegisteredPhones,
                  value: formatCount(s.registrations),
                  icon: Icons.phone_android_outlined,
                ),
                StatTile(
                  label: l.opsCallsInProgress,
                  value: formatCount(s.activeDialogs),
                  icon: Icons.call_outlined,
                  detail: l.opsAnsweredDialogs,
                ),
                StatTile(
                  label: l.opsCallsRinging,
                  value: formatCount(s.earlyDialogs),
                  icon: Icons.ring_volume_outlined,
                  detail: l.opsEarlyDialogs,
                ),
                StatTile(
                  label: l.opsTransactions,
                  value: formatCount(s.transactions),
                  icon: Icons.swap_horiz,
                  detail: l.opsInProgress,
                ),
                StatTile(
                  label: l.opsSharedMemory,
                  value: formatPercent(
                    shmShare == null ? null : shmShare * 100,
                  ),
                  icon: Icons.memory_outlined,
                  health: shmShare == null
                      ? null
                      : shmShare >= 0.9
                      ? Health.bad
                      : shmShare >= 0.7
                      ? Health.attention
                      : Health.good,
                  detail: l.opsPartOfWhole(
                    formatBytes(s.shmUsedBytes),
                    formatBytes(s.shmTotalBytes),
                  ),
                ),
              ],
            ),
          const SizedBox(height: 16),
          Panel(
            title: l.opsMediaNodesAtEdge,
            subtitle: l.opsMediaNodesAtEdgeHelp,
            child: overview.nodes.isEmpty
                ? Text(l.opsNoMediaNodes, style: theme.textTheme.bodyMedium)
                : _WideTable(
                    columns: [
                      l.opsColNode,
                      l.opsColAddress,
                      l.opsColState,
                      l.opsWeight,
                      l.opsColShare,
                    ],
                    rows: [
                      for (final n in overview.nodes)
                        DataRow(
                          cells: [
                            DataCell(Text(n.nodeId)),
                            DataCell(Text(n.uri ?? noValue)),
                            DataCell(() {
                              final (health, label) = dispatcherHealth(
                                n.dispatcher,
                              );
                              return HealthLabel(health, label, dense: true);
                            }()),
                            DataCell(
                              Text(n.weight == null ? noValue : '${n.weight}'),
                            ),
                            DataCell(Text(_share(n))),
                          ],
                        ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }

  /// The node's share of new calls: its weight over the weights in rotation.
  String _share(MediaNode node) {
    if (node.dispatcher != 'active' || node.weight == null) return '0%';
    final total = overview.nodes
        .where((n) => n.dispatcher == 'active' && n.weight != null)
        .fold(0, (sum, n) => sum + n.weight!);
    return total == 0 ? noValue : formatPercent(node.weight! / total * 100);
  }
}

/// The Events tab: the streams and how far behind each consumer is.
class EventsTab extends StatelessWidget {
  const EventsTab({super.key, required this.overview});

  final Overview overview;

  @override
  Widget build(BuildContext context) {
    final events = overview.events;
    final l = context.l10n;
    if (events == null) {
      return Card(
        margin: EdgeInsets.zero,
        child: Unavailable(l.opsEventBusDown),
      );
    }
    final consumers = [...events.consumers]
      ..sort((a, b) {
        final byBacklog = b.backlog.compareTo(a.backlog);
        return byBacklog != 0 ? byBacklog : a.name.compareTo(b.name);
      });
    return SingleChildScrollView(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ResponsiveGrid(
            minWidth: 420,
            maxColumns: 2,
            children: [
              Panel(
                title: l.opsMessagesPerStream,
                subtitle: l.opsMessagesPerStreamHelp,
                child: ValueBarChart(
                  items: [
                    for (final s in events.streams)
                      (s.name, s.messages.toDouble()),
                  ],
                  format: (v) => formatCount(v),
                  emptyText: l.opsNoStreams,
                ),
              ),
              Panel(
                title: l.opsStreams,
                child: _WideTable(
                  columns: [
                    l.opsColStream,
                    l.opsColMessages,
                    l.opsColSize,
                    l.opsConsumers,
                  ],
                  rows: [
                    for (final s in events.streams)
                      DataRow(
                        cells: [
                          DataCell(Text(s.name)),
                          DataCell(Text(formatCount(s.messages))),
                          DataCell(Text(formatBytes(s.bytes))),
                          DataCell(Text(formatCount(s.consumers))),
                        ],
                      ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Panel(
            title: l.opsConsumers,
            subtitle: l.opsConsumersHelp,
            child: _WideTable(
              columns: [
                l.opsColConsumer,
                l.opsColStream,
                l.opsColWaiting,
                l.opsColUnacknowledged,
                l.opsColRedelivered,
              ],
              rows: [
                for (final c in consumers)
                  DataRow(
                    cells: [
                      DataCell(
                        c.backlog > 0
                            ? HealthLabel(Health.attention, c.name, dense: true)
                            : Text(c.name),
                      ),
                      DataCell(Text(c.stream)),
                      DataCell(Text(formatCount(c.pending))),
                      DataCell(Text(formatCount(c.ackPending))),
                      DataCell(Text(formatCount(c.redelivered))),
                    ],
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The Data stores tab: a card per store with what it reports.
class DataStoresTab extends StatelessWidget {
  const DataStoresTab({super.key, required this.overview});

  final Overview overview;

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    if (overview.dataStores.isEmpty) {
      return Center(child: Text(l.opsNoDataStores));
    }
    final theme = Theme.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.only(bottom: 24),
      child: ResponsiveGrid(
        minWidth: 320,
        maxColumns: 3,
        children: [
          for (final store in overview.dataStores)
            Card(
              margin: EdgeInsets.zero,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(
                          _storeIcon(store.name),
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            _storeName(store.name),
                            style: theme.textTheme.titleMedium,
                          ),
                        ),
                        HealthChip(
                          serviceHealth(store.status).$1,
                          serviceHealth(store.status).$2,
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      [
                        if (store.version != null)
                          l.opsVersionIs('${store.version}'),
                        if (store.uptimeSeconds != null)
                          l.opsUpForLower(formatSpan(store.uptimeSeconds)),
                      ].join(', '),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 16),
                    if (store.facts.isEmpty)
                      Text(
                        l.opsNothingReported,
                        style: theme.textTheme.bodyMedium,
                      )
                    else
                      Wrap(
                        spacing: 24,
                        runSpacing: 12,
                        children: [
                          for (final f in store.facts)
                            Fact(f.label, formatFact(f.value, f.unit)),
                        ],
                      ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  static IconData _storeIcon(String name) => switch (name) {
    'redis' => Icons.bolt_outlined,
    'mariadb' => Icons.storage_outlined,
    'nats' => Icons.hub_outlined,
    _ => Icons.inventory_2_outlined,
  };

  /// The store as an operator names it; an unknown one as it came.
  static String _storeName(String name) => switch (name) {
    'redis' => 'Redis',
    'mariadb' => 'MariaDB',
    'nats' => 'NATS',
    _ => name,
  };
}
