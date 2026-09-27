import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../core/problem.dart';
import 'operations_api.dart';
import 'operations_widgets.dart';

/// The Media nodes tab: a card per FreeSWITCH node, with its actions for those
/// who may take them (`platform.operate`).
class NodesTab extends ConsumerWidget {
  const NodesTab({super.key, required this.overview});

  final Overview overview;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (overview.nodes.isEmpty) {
      return const Center(child: Text('No media nodes are configured.'));
    }
    final canOperate = ref.watch(canProvider('platform.operate'));
    return SingleChildScrollView(
      padding: const EdgeInsets.only(bottom: 24),
      child: ResponsiveGrid(
        minWidth: 340,
        maxColumns: 3,
        children: [
          for (final node in overview.nodes)
            NodeCard(node: node, canOperate: canOperate),
        ],
      ),
    );
  }
}

class NodeCard extends ConsumerStatefulWidget {
  const NodeCard({super.key, required this.node, required this.canOperate});

  final MediaNode node;
  final bool canOperate;

  @override
  ConsumerState<NodeCard> createState() => _NodeCardState();
}

class _NodeCardState extends ConsumerState<NodeCard> {
  bool _busy = false;

  MediaNode get node => widget.node;

  Future<void> _run(Future<void> Function() action, String done) async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      await action();
      ref.invalidate(operationsOverviewProvider);
      messenger.showSnackBar(SnackBar(content: Text(done)));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(problemMessage(e))));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _drain() async {
    final ok = await _confirm(
      title: 'Drain ${node.nodeId}?',
      body:
          'It stops taking new calls within a few seconds. Its queues, parking '
          'lots and conference rooms move to other nodes the next time they are '
          'used. Calls already on it carry on until they end.\n\n'
          'It stays drained, even if it restarts, until you return it to '
          'service.',
      action: 'Drain',
    );
    if (!ok) return;
    await _run(
      () => ref.read(operationsApiProvider).drain(node.nodeId),
      '${node.nodeId} is draining.',
    );
  }

  Future<void> _undrain() async {
    final ok = await _confirm(
      title: 'Return ${node.nodeId} to service?',
      body:
          'It takes new calls again, in its share by weight. Queues, parking '
          'lots and conference rooms come to it as they are next used.',
      action: 'Return to service',
    );
    if (!ok) return;
    await _run(
      () => ref.read(operationsApiProvider).undrain(node.nodeId),
      '${node.nodeId} is back in service.',
    );
  }

  Future<void> _setWeight() async {
    final weight = await showDialog<int>(
      context: context,
      builder: (context) =>
          WeightDialog(nodeId: node.nodeId, current: node.weight ?? minWeight),
    );
    if (weight == null || weight == node.weight) return;
    await _run(
      () => ref.read(operationsApiProvider).setWeight(node.nodeId, weight),
      '${node.nodeId} now has weight $weight.',
    );
  }

  Future<bool> _confirm({
    required String title,
    required String body,
    required String action,
  }) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: Text(body),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: Text(action),
            ),
          ],
        ),
      ) ??
      false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final (health, label) = nodeHealth(node.status);
    final (edgeHealth, edgeLabel) = dispatcherHealth(node.dispatcher);
    final sessions = node.sessions;
    final max = node.maxSessions;
    final sessionShare = sessions != null && max != null && max > 0
        ? (sessions / max).clamp(0.0, 1.0)
        : null;
    final cpu = node.cpuBusyPercent;
    final heartbeat = DateTime.tryParse(node.heartbeatAt ?? '');

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.dns_outlined, color: scheme.onSurfaceVariant),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        node.nodeId,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.titleMedium,
                      ),
                      Text(
                        node.uri ?? 'No address at the edge',
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                HealthChip(health, label),
                HealthChip(edgeHealth, edgeLabel),
              ],
            ),
            const SizedBox(height: 16),
            Wrap(
              spacing: 24,
              runSpacing: 12,
              children: [
                Fact('Calls', formatCount(node.calls)),
                Fact('Leases', formatCount(node.leases)),
                Fact(
                  'Weight',
                  node.weight == null ? noValue : '${node.weight}',
                ),
                Fact('Uptime', formatDuration(node.uptimeSeconds)),
                Fact(
                  'New sessions',
                  node.sessionsPerSecond == null
                      ? noValue
                      : '${node.sessionsPerSecond!.toStringAsFixed(1)}/s',
                ),
              ],
            ),
            const SizedBox(height: 16),
            _Meter(
              label: 'Sessions',
              value: sessionShare,
              text: sessions == null
                  ? noValue
                  : max == null
                  ? formatCount(sessions)
                  : '${formatCount(sessions)} of ${formatCount(max)}',
            ),
            const SizedBox(height: 12),
            _Meter(
              label: 'CPU busy',
              value: cpu == null ? null : cpu / 100,
              text: formatPercent(cpu),
              warn: cpu != null && cpu >= 70,
              critical: cpu != null && cpu >= 90,
            ),
            const SizedBox(height: 12),
            Text(
              heartbeat == null
                  ? 'No heartbeat reported yet.'
                  : 'Last heartbeat ${_clock(heartbeat)} UTC.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
            if (widget.canOperate) ...[
              const Divider(height: 32),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (node.draining)
                    FilledButton.tonalIcon(
                      onPressed: _busy ? null : _undrain,
                      icon: const Icon(Icons.play_circle_outline),
                      label: const Text('Return to service'),
                    )
                  else
                    OutlinedButton.icon(
                      onPressed: _busy ? null : _drain,
                      icon: const Icon(Icons.pause_circle_outline),
                      label: const Text('Drain'),
                    ),
                  Tooltip(
                    message: node.weight == null
                        ? 'This node is not in the edge list, so it has no weight.'
                        : 'Its share of new calls against the other nodes.',
                    child: TextButton.icon(
                      onPressed: _busy || node.weight == null
                          ? null
                          : _setWeight,
                      icon: const Icon(Icons.balance_outlined),
                      label: const Text('Set weight'),
                    ),
                  ),
                  if (_busy)
                    const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

String _clock(DateTime at) {
  final utc = at.toUtc();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(utc.hour)}:${two(utc.minute)}:${two(utc.second)}';
}

/// A labelled bar for a share of a whole: sessions of the maximum, CPU busy.
class _Meter extends StatelessWidget {
  const _Meter({
    required this.label,
    required this.value,
    required this.text,
    this.warn = false,
    this.critical = false,
  });

  final String label;
  final double? value;
  final String text;
  final bool warn;
  final bool critical;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final color = critical
        ? scheme.error
        : warn
        ? scheme.tertiary
        : scheme.primary;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                label,
                style: theme.textTheme.labelMedium?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ),
            Text(text, style: theme.textTheme.labelMedium),
          ],
        ),
        const SizedBox(height: 6),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            value: value ?? 0,
            minHeight: 8,
            color: color,
            backgroundColor: scheme.surfaceContainerHighest,
          ),
        ),
      ],
    );
  }
}

/// Asks for a node's new weight, 1 to 999.
class WeightDialog extends StatefulWidget {
  const WeightDialog({super.key, required this.nodeId, required this.current});

  final String nodeId;
  final int current;

  @override
  State<WeightDialog> createState() => _WeightDialogState();
}

class _WeightDialogState extends State<WeightDialog> {
  late final _controller = TextEditingController(text: '${widget.current}');
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final error = weightError(_controller.text);
    if (error != null) {
      setState(() => _error = error);
      return;
    }
    Navigator.of(context).pop(int.parse(_controller.text.trim()));
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text('Set the weight of ${widget.nodeId}'),
    content: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 440),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'New calls are shared out by weight: a node with weight 2 takes two '
            'calls for every one a node with weight 1 takes. The weight is kept '
            'when the edge restarts. To send a node no calls, drain it instead.',
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _controller,
            autofocus: true,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: InputDecoration(
              labelText: 'Weight',
              helperText: 'From $minWeight to $maxWeight.',
              errorText: _error,
              border: const OutlineInputBorder(),
            ),
            onChanged: (_) {
              if (_error != null) setState(() => _error = null);
            },
            onSubmitted: (_) => _submit(),
          ),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('Cancel'),
      ),
      FilledButton(onPressed: _submit, child: const Text('Save')),
    ],
  );
}
