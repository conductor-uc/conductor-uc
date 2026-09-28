import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/problem.dart';
import '../../l10n/l10n.dart';
import '../../widgets/page.dart';
import 'operations_api.dart';
import 'operations_nodes.dart';
import 'operations_overview.dart';
import 'operations_tables.dart';
import '../../core/format.dart';

/// How often the page asks for a new reading while it is open.
const operationsRefresh = Duration(seconds: 5);

/// The master's Operations console (11 §2.3): every service, the media nodes,
/// the SIP edge, the event bus and the data stores, read every five seconds;
/// and the media node actions for those who may take them.
class OperationsPage extends ConsumerStatefulWidget {
  const OperationsPage({super.key});

  @override
  ConsumerState<OperationsPage> createState() => _OperationsPageState();
}

class _OperationsPageState extends ConsumerState<OperationsPage> {
  Timer? _timer;

  static List<(IconData, String)> _tabs(AppLocalizations l) => [
    (Icons.space_dashboard_outlined, l.opsTabOverview),
    (Icons.dns_outlined, l.opsTabServices),
    (Icons.graphic_eq, l.opsTabMediaNodes),
    (Icons.router_outlined, l.opsTabSignalling),
    (Icons.hub_outlined, l.opsTabEvents),
    (Icons.storage_outlined, l.opsTabDataStores),
  ];

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(
      operationsRefresh,
      (_) => ref.invalidate(operationsOverviewProvider),
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Every new reading is a point on the Overview's rolling lines.
    ref.listen(operationsOverviewProvider, (_, next) {
      final overview = next.value;
      if (overview != null && !next.isLoading) {
        ref.read(operationsHistoryProvider.notifier).add(overview);
      }
    });
    final overview = ref.watch(operationsOverviewProvider);
    final theme = Theme.of(context);
    final checked = overview.value?.checkedAt;
    final l = context.l10n;
    final tabs = _tabs(l);

    return DefaultTabController(
      length: tabs.length,
      child: PageFrame(
        children: [
          PageHeader(
            title: l.navOperations,
            subtitle: checked == null
                ? l.opsSubtitle
                : l.opsReadAt(
                    formatUtcClock(checked),
                    operationsRefresh.inSeconds,
                  ),
            actions: [
              if (overview.isLoading && overview.hasValue)
                const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              IconButton(
                tooltip: l.opsReadNow,
                icon: const Icon(Icons.refresh),
                onPressed: () => ref.invalidate(operationsOverviewProvider),
              ),
            ],
          ),
          if (overview.hasError && overview.hasValue) ...[
            const SizedBox(height: 8),
            // A failed reading keeps the last one on screen, and says so.
            ErrorText(l.opsLastReadingFailed(problemMessage(overview.error!))),
          ],
          const SizedBox(height: 8),
          TabBar(
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            dividerColor: theme.colorScheme.outlineVariant,
            tabs: [
              for (final (icon, label) in tabs)
                Tab(
                  height: 44,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(icon, size: 18),
                      const SizedBox(width: 8),
                      Text(label),
                    ],
                  ),
                ),
            ],
          ),
          const SizedBox(height: 16),
          Expanded(
            child: AsyncBody<Overview>(
              value: overview,
              emptyText: l.opsNothingToShow,
              isEmpty: (_) => false,
              builder: (o) => TabBarView(
                children: [
                  OverviewTab(overview: o),
                  ServicesTab(overview: o),
                  NodesTab(overview: o),
                  SignallingTab(overview: o),
                  EventsTab(overview: o),
                  DataStoresTab(overview: o),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
