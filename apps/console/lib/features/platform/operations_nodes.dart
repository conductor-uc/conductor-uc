import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../core/problem.dart';
import '../../l10n/l10n.dart';
import 'operations_api.dart';
import 'operations_widgets.dart';
import '../../core/format.dart';

/// The Media nodes tab: a card per FreeSWITCH node, with its actions for those
/// who may take them (`platform.operate`).
class NodesTab extends ConsumerWidget {
  const NodesTab({super.key, required this.overview});

  final Overview overview;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (overview.nodes.isEmpty) {
      return Center(child: Text(context.l10n.opsNoMediaNodes));
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
    final l = context.l10n;
    final ok = await _confirm(
      title: l.opsDrainTitle(node.nodeId),
      body: l.opsDrainBody,
      action: l.opsDrain,
    );
    if (!ok) return;
    await _run(
      () => ref.read(operationsApiProvider).drain(node.nodeId),
      l.opsDraining(node.nodeId),
    );
  }

  Future<void> _undrain() async {
    final l = context.l10n;
    final ok = await _confirm(
      title: l.opsReturnTitle(node.nodeId),
      body: l.opsReturnBody,
      action: l.opsReturnToService,
    );
    if (!ok) return;
    await _run(
      () => ref.read(operationsApiProvider).undrain(node.nodeId),
      l.opsBackInService(node.nodeId),
    );
  }

  Future<void> _setWeight() async {
    final l = context.l10n;
    final weight = await showDialog<int>(
      context: context,
      builder: (context) =>
          WeightDialog(nodeId: node.nodeId, current: node.weight ?? minWeight),
    );
    if (weight == null || weight == node.weight) return;
    await _run(
      () => ref.read(operationsApiProvider).setWeight(node.nodeId, weight),
      l.opsWeightSet(node.nodeId, weight),
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
              child: Text(context.l10n.commonCancel),
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
    final l = context.l10n;

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
                        node.uri ?? l.opsNoEdgeAddress,
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
                Fact(l.opsCalls, formatCount(node.calls)),
                Fact(l.opsLeases, formatCount(node.leases)),
                Fact(
                  l.opsWeight,
                  node.weight == null ? noValue : '${node.weight}',
                ),
                Fact(l.opsUptime, formatSpan(node.uptimeSeconds)),
                Fact(l.opsNewSessions, formatRate(node.sessionsPerSecond)),
              ],
            ),
            const SizedBox(height: 16),
            _Meter(
              label: l.opsSessions,
              value: sessionShare,
              text: sessions == null
                  ? noValue
                  : max == null
                  ? formatCount(sessions)
                  : l.opsPartOfWhole(formatCount(sessions), formatCount(max)),
            ),
            const SizedBox(height: 12),
            _Meter(
              label: l.opsCpuBusy,
              value: cpu == null ? null : cpu / 100,
              text: formatPercent(cpu),
              warn: cpu != null && cpu >= 70,
              critical: cpu != null && cpu >= 90,
            ),
            const SizedBox(height: 12),
            Text(
              heartbeat == null
                  ? l.opsNoHeartbeat
                  : l.opsLastHeartbeat(formatUtcClock(heartbeat)),
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
                      label: Text(l.opsReturnToService),
                    )
                  else
                    OutlinedButton.icon(
                      onPressed: _busy ? null : _drain,
                      icon: const Icon(Icons.pause_circle_outline),
                      label: Text(l.opsDrain),
                    ),
                  Tooltip(
                    message: node.weight == null
                        ? l.opsNoWeightHelp
                        : l.opsWeightHelp,
                    child: TextButton.icon(
                      onPressed: _busy || node.weight == null
                          ? null
                          : _setWeight,
                      icon: const Icon(Icons.balance_outlined),
                      label: Text(l.opsSetWeight),
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
    title: Text(context.l10n.opsSetWeightTitle(widget.nodeId)),
    content: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 440),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(context.l10n.opsWeightExplain),
          const SizedBox(height: 16),
          TextField(
            controller: _controller,
            autofocus: true,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: InputDecoration(
              labelText: context.l10n.opsWeight,
              helperText: context.l10n.opsWeightRange(minWeight, maxWeight),
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
        child: Text(context.l10n.commonCancel),
      ),
      FilledButton(onPressed: _submit, child: Text(context.l10n.commonSave)),
    ],
  );
}
