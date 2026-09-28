import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../l10n/l10n.dart';
import '../../widgets/commit_field.dart';
import '../../widgets/page.dart';
import '../callflow/builder/lookups.dart';
import '../pbx/pbx_api.dart';

/// Which agents answer a queue, in what order. Agents at a lower level are
/// tried first; the position orders agents within a level (05 §3.3).
class QueueTiersDialog extends ConsumerStatefulWidget {
  const QueueTiersDialog({super.key, required this.queue});

  final Json queue;

  @override
  ConsumerState<QueueTiersDialog> createState() => _QueueTiersDialogState();
}

class _QueueTiersDialogState extends ConsumerState<QueueTiersDialog> {
  List<Json>? _tiers;
  String? _error;
  String? _newAgent;
  var _newLevel = 1;
  var _newPosition = 1;

  String get _queueId => '${widget.queue['id']}';
  PbxApi get _api => ref.read(pbxApiProvider)!;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final body = await _api.call('GET', 'queues', _queueId, 'tiers') as Map;
      final rows =
          [
            for (final r in body['rows'] as List)
              (r as Map).cast<String, dynamic>(),
          ]..sort((a, b) {
            final byLevel = (a['level'] as num).compareTo(b['level'] as num);
            return byLevel != 0
                ? byLevel
                : (a['position'] as num).compareTo(b['position'] as num);
          });
      if (mounted) {
        setState(() {
          _tiers = rows;
          _error = null;
          _newPosition = rows.length + 1;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    try {
      await action();
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    }
  }

  Future<void> _add() => _run(() async {
    await _api.call(
      'POST',
      'queues',
      _queueId,
      'tiers',
      body: {
        'agentId': _newAgent,
        'level': _newLevel,
        'position': _newPosition,
      },
    );
    _newAgent = null;
  });

  Future<void> _change(Json tier, String key, String text) {
    final n = int.tryParse(text.trim());
    if (n == null || n < 1 || n > 100) {
      setState(() => _error = context.l10n.tierNumberRange);
      return Future.value();
    }
    return _run(
      () => _api.call(
        'PATCH',
        'queues',
        _queueId,
        'tiers/${tier['id']}',
        body: {key: n},
      ),
    );
  }

  Future<void> _remove(Json tier) => _run(
    () => _api.call('DELETE', 'queues', _queueId, 'tiers/${tier['id']}'),
  );

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final agents = ref.watch(optionsProvider('agents')).asData?.value ?? {};
    final tiers = _tiers;
    // Someone who can read queues but not change them sees who answers only.
    final canChange = ref.watch(canProvider('queue.manage'));
    final used = {for (final t in tiers ?? <Json>[]) '${t['agentId']}'};
    final free = {
      for (final e in agents.entries)
        if (!used.contains(e.key)) e.key: e.value,
    };
    return AlertDialog(
      title: Text(
        widget.queue['label'] == null
            ? l.tierTitleUnnamed
            : l.tierTitle('${widget.queue['label']}'),
      ),
      content: SizedBox(
        width: 560,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l.tierIntro),
            const SizedBox(height: 12),
            if (tiers == null && _error == null)
              const LinearProgressIndicator(),
            if (tiers != null && tiers.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Text(l.tierNone),
              ),
            if (tiers != null)
              Flexible(
                child: SingleChildScrollView(
                  child: Column(
                    children: [
                      for (final t in tiers)
                        Padding(
                          key: ValueKey('tier-${t['id']}'),
                          padding: const EdgeInsets.only(bottom: 8),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  agents['${t['agentId']}'] ??
                                      '${t['agentId']}',
                                ),
                              ),
                              if (!canChange)
                                Text(
                                  l.tierLevelPosition(
                                    '${t['level']}',
                                    '${t['position']}',
                                  ),
                                )
                              else ...[
                                SizedBox(
                                  width: 90,
                                  child: CommitField(
                                    label: l.tierLevel,
                                    value: '${t['level']}',
                                    number: true,
                                    onCommit: (v) => _change(t, 'level', v),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                SizedBox(
                                  width: 90,
                                  child: CommitField(
                                    label: l.tierPosition,
                                    value: '${t['position']}',
                                    number: true,
                                    onCommit: (v) => _change(t, 'position', v),
                                  ),
                                ),
                                IconButton(
                                  tooltip: l.tierRemove,
                                  icon: const Icon(Icons.close),
                                  onPressed: () => _remove(t),
                                ),
                              ],
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            if (canChange) const Divider(height: 24),
            if (canChange)
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      key: ValueKey('new-agent-$_newAgent-${free.length}'),
                      initialValue: _newAgent,
                      isExpanded: true,
                      decoration: InputDecoration(
                        labelText: l.tierAddAgent,
                        helperText: free.isEmpty ? l.tierAllAdded : null,
                      ),
                      items: [
                        for (final e in free.entries)
                          DropdownMenuItem(value: e.key, child: Text(e.value)),
                      ],
                      onChanged: (v) => setState(() => _newAgent = v),
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 80,
                    child: CommitField(
                      label: l.tierLevel,
                      value: '$_newLevel',
                      number: true,
                      onCommit: (v) => _newLevel = int.tryParse(v.trim()) ?? 1,
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 80,
                    child: CommitField(
                      label: l.tierPosition,
                      value: '$_newPosition',
                      number: true,
                      onCommit: (v) =>
                          _newPosition = int.tryParse(v.trim()) ?? 1,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: FilledButton(
                      onPressed: _newAgent == null ? null : _add,
                      child: Text(l.tierAdd),
                    ),
                  ),
                ],
              ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              ErrorText(_error!),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l.tierDone),
        ),
      ],
    );
  }
}
