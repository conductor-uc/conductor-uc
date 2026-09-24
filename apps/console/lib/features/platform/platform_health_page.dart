import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/authed_get.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';

/// One reading of every service's readiness, from the gateway.
class PlatformHealth {
  const PlatformHealth(this.checkedAt, this.services);

  final String checkedAt;
  final List<Json> services;

  int get ready => services.where((s) => s['status'] == 'up').length;
}

final platformHealthProvider = FutureProvider.autoDispose<PlatformHealth>((
  ref,
) async {
  final body = await authedGet(ref, '/v1/platform/health') as Map;
  return PlatformHealth('${body['checkedAt']}', [
    for (final s in body['services'] as List)
      (s as Map).cast<String, dynamic>(),
  ]);
});

/// Whether each service is ready, refreshed every half minute. It reports
/// only what the services themselves say about their own readiness.
class PlatformHealthPage extends ConsumerStatefulWidget {
  const PlatformHealthPage({super.key});

  @override
  ConsumerState<PlatformHealthPage> createState() => _PlatformHealthPageState();
}

class _PlatformHealthPageState extends ConsumerState<PlatformHealthPage> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(
      const Duration(seconds: 30),
      (_) => ref.invalidate(platformHealthProvider),
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final health = ref.watch(platformHealthProvider);
    final theme = Theme.of(context);
    return PageFrame(
      children: [
        PageHeader(
          title: 'Platform health',
          subtitle: health.value == null
              ? 'Whether each service reports itself ready.'
              : '${health.value!.ready} of ${health.value!.services.length} services ready. '
                    'Checked ${health.value!.checkedAt.replaceFirst('T', ' ').split('.').first} UTC.',
          actions: [
            IconButton(
              tooltip: 'Check now',
              icon: const Icon(Icons.refresh),
              onPressed: () => ref.invalidate(platformHealthProvider),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody(
            // Keep showing the last reading while the next one loads.
            value: health,
            emptyText: 'No services are configured.',
            isEmpty: (h) => h.services.isEmpty,
            builder: (h) => SingleChildScrollView(
              child: DataTable(
                columns: const [
                  DataColumn(label: Text('Service')),
                  DataColumn(label: Text('Status')),
                  DataColumn(label: Text('Response')),
                  DataColumn(label: Text('Version')),
                  DataColumn(label: Text('Not ready')),
                ],
                rows: [
                  for (final s in h.services)
                    DataRow(
                      cells: [
                        DataCell(Text('${s['name']}')),
                        DataCell(_status(theme, '${s['status']}')),
                        DataCell(
                          Text(
                            s['status'] == 'down'
                                ? '—'
                                : '${(s['latencyMs'] as num).round()} ms',
                          ),
                        ),
                        DataCell(Text('${s['version'] ?? '—'}')),
                        DataCell(
                          Text(
                            ((s['failing'] as List?) ?? const []).isEmpty
                                ? '—'
                                : (s['failing'] as List).join(', '),
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _status(ThemeData theme, String status) {
    final (icon, label, color) = switch (status) {
      'up' => (Icons.check_circle_outline, 'Ready', null),
      'degraded' => (Icons.warning_amber_outlined, 'Not ready', null),
      _ => (Icons.error_outline, 'Unreachable', theme.colorScheme.error),
    };
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: 6),
        Text(label, style: TextStyle(color: color)),
      ],
    );
  }
}
