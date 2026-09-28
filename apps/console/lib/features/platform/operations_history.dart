import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/problem.dart';
import '../../l10n/l10n.dart';
import 'operations_api.dart';
import 'operations_charts.dart';

/// The range the History tab shows, kept while the page is open.
class HistoryRange extends Notifier<String> {
  @override
  String build() => '1h';

  void choose(String range) => state = range;
}

final historyRangeProvider = NotifierProvider<HistoryRange, String>(
  HistoryRange.new,
);

const _ranges = ['1h', '6h', '24h', '7d'];

/// S4-13 (G-124): the platform over the last hour to week, from Prometheus
/// through the gateway's fixed chart catalog (11 §3). Each chart is asked for
/// on its own; when the platform keeps no history (no `PROMETHEUS_URL`), the
/// tab says so once instead of ten empty charts.
class HistoryTab extends ConsumerWidget {
  const HistoryTab({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final range = ref.watch(historyRangeProvider);
    final probe = ref.watch(historyChartProvider((historyCharts.first, range)));
    final unavailable =
        probe.hasError &&
        problemOf(probe.error!)?.code == 'history_unavailable';
    return ListView(
      padding: const EdgeInsets.only(top: 16),
      children: [
        Wrap(
          spacing: 12,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(l10n.opsHistoryRange),
            SegmentedButton<String>(
              key: const ValueKey('history-range'),
              showSelectedIcon: false,
              segments: [
                for (final r in _ranges)
                  ButtonSegment(value: r, label: Text(_rangeLabel(l10n, r))),
              ],
              selected: {range},
              onSelectionChanged: (chosen) =>
                  ref.read(historyRangeProvider.notifier).choose(chosen.first),
            ),
          ],
        ),
        const SizedBox(height: 16),
        if (unavailable)
          Card(
            key: const ValueKey('history-unavailable'),
            child: ListTile(
              leading: const Icon(Icons.history_toggle_off),
              title: Text(l10n.opsHistoryUnavailable),
              subtitle: Text(l10n.opsHistoryUnavailableHelp),
            ),
          )
        else
          Wrap(
            spacing: 16,
            runSpacing: 16,
            children: [
              for (final chart in historyCharts)
                _ChartCard(chart: chart, range: range),
            ],
          ),
      ],
    );
  }
}

String _rangeLabel(AppLocalizations l, String range) => switch (range) {
  '1h' => l.opsRangeHour,
  '6h' => l.opsRangeSixHours,
  '24h' => l.opsRangeDay,
  _ => l.opsRangeWeek,
};

String _title(AppLocalizations l, String chart) => switch (chart) {
  'calls-by-node' => l.opsChartCallsByNode,
  'sessions-by-node' => l.opsChartSessionsByNode,
  'node-cpu' => l.opsChartNodeCpu,
  'registrations' => l.opsChartRegistrations,
  'dialogs' => l.opsChartDialogs,
  'request-rate' => l.opsChartRequestRate,
  'error-rate' => l.opsChartErrorRate,
  'latency-p95' => l.opsChartLatency,
  'outbox-pending' => l.opsChartOutbox,
  _ => l.opsChartConsumerBacklog,
};

/// The catalog's units, in the console's own formats.
String Function(double) formatterFor(String unit) => switch (unit) {
  'percent' => (v) => formatPercent(v),
  'perSecond' => (v) => formatRate(v),
  'seconds' => (v) => formatMs(v * 1000),
  _ => (v) => formatCount(v),
};

class _ChartCard extends ConsumerWidget {
  const _ChartCard({required this.chart, required this.range});

  final String chart;
  final String range;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final value = ref.watch(historyChartProvider((chart, range)));
    return SizedBox(
      width: 520,
      child: Card(
        key: ValueKey('history-$chart'),
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                _title(l10n, chart),
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(height: 12),
              value.when(
                loading: () => const SizedBox(
                  height: 180,
                  child: Center(child: CircularProgressIndicator()),
                ),
                error: (e, _) => SizedBox(
                  height: 180,
                  child: Center(child: Text(problemMessage(e))),
                ),
                data: (history) => HistoryLines(
                  series: [for (final s in history.series) (s.label, s.points)],
                  format: formatterFor(history.unit),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
