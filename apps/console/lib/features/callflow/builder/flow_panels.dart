import 'package:flutter/material.dart';

import '../../../canvas/canvas.dart';
import '../../../l10n/l10n.dart';
import '../../../widgets/page.dart';
import '../../pbx/pbx_api.dart';
import 'flow_graph.dart';
import 'local_validation.dart';
import 'node_types.dart';
import '../../../widgets/commit_field.dart';

/// "Menu (greet)": how a node is named where it is picked or listed.
String nodeLabel(CanvasNode node) =>
    '${flowNodeType(node.type)?.label ?? node.type} (${node.id})';

/// The flow as a whole: where calls start, and everything wrong with it.
class FlowPanel extends StatelessWidget {
  const FlowPanel({
    super.key,
    required this.nodes,
    required this.entryPoints,
    required this.issues,
    required this.checkedByService,
    required this.onEntryPoints,
    required this.onSelect,
  });

  final Map<String, CanvasNode> nodes;
  final Map<String, String> entryPoints;
  final List<FlowIssue> issues;

  /// Whether [issues] came from the service's own check rather than the
  /// local one.
  final bool checkedByService;
  final void Function(Map<String, String> next) onEntryPoints;
  final void Function(String nodeId) onSelect;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = context.l10n;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(l.flowWhereCallsStart, style: theme.textTheme.titleSmall),
        const SizedBox(height: 4),
        Text(l.flowWhereCallsStartHelp, style: theme.textTheme.bodySmall),
        const SizedBox(height: 8),
        for (final e in entryPoints.entries)
          Padding(
            key: ValueKey('start-${e.key}'),
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              children: [
                SizedBox(
                  width: 100,
                  child: CommitField(
                    label: l.fieldName,
                    value: e.key,
                    onCommit: (name) {
                      final n = name.trim();
                      if (n.isEmpty ||
                          (n != e.key && entryPoints.containsKey(n))) {
                        return;
                      }
                      onEntryPoints({
                        for (final x in entryPoints.entries)
                          if (x.key == e.key) n: x.value else x.key: x.value,
                      });
                    },
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: DropdownButtonFormField<String>(
                    initialValue: e.value,
                    isExpanded: true,
                    decoration: InputDecoration(labelText: l.flowStartsAt),
                    items: [
                      for (final n in nodes.values)
                        DropdownMenuItem(
                          value: n.id,
                          child: Text(nodeLabel(n)),
                        ),
                      if (!nodes.containsKey(e.value))
                        DropdownMenuItem(
                          value: e.value,
                          child: Text(l.flowRefMissing(e.value)),
                        ),
                    ],
                    onChanged: (v) => v == null
                        ? null
                        : onEntryPoints({...entryPoints, e.key: v}),
                  ),
                ),
                IconButton(
                  tooltip: l.flowRemoveStart,
                  icon: const Icon(Icons.close),
                  onPressed: () =>
                      onEntryPoints({...entryPoints}..remove(e.key)),
                ),
              ],
            ),
          ),
        if (entryPoints.isEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(l.flowNoStart),
          ),
        OutlinedButton.icon(
          onPressed: nodes.isEmpty
              ? null
              : () {
                  var name = 'main';
                  for (var i = 2; entryPoints.containsKey(name); i++) {
                    name = 'start$i';
                  }
                  onEntryPoints({...entryPoints, name: nodes.keys.first});
                },
          icon: const Icon(Icons.add),
          label: Text(l.flowAddStart),
        ),
        const Divider(height: 32),
        Text(
          checkedByService ? l.flowProblemsByService : l.flowProblems,
          style: theme.textTheme.titleSmall,
        ),
        const SizedBox(height: 4),
        if (issues.isEmpty) Text(l.flowNoProblems),
        for (final i in issues)
          ListTile(
            key: ValueKey('issue-${i.kind}-${i.nodeId}-${i.message.hashCode}'),
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: Icon(
              Icons.error_outline,
              size: 18,
              color: theme.colorScheme.error,
            ),
            title: Text(i.message),
            onTap: i.nodeId != null && nodes.containsKey(i.nodeId)
                ? () => onSelect(i.nodeId!)
                : null,
          ),
      ],
    );
  }
}

/// Published versions: which is live, roll back to one, or copy one into the
/// draft to work from.
class HistoryPanel extends StatelessWidget {
  const HistoryPanel({
    super.key,
    required this.versions,
    required this.currentVersionId,
    required this.onRollback,
    required this.onOpenAsDraft,
    this.canRollback = true,
  });

  final List<Json> versions;
  final String? currentVersionId;
  final void Function(int versionNumber) onRollback;
  final void Function(int versionNumber) onOpenAsDraft;

  /// Rolling back changes what calls do, so it needs the publish permission.
  final bool canRollback;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = context.l10n;
    final newestFirst = versions.reversed.toList();
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(l.flowPublishedVersions, style: theme.textTheme.titleSmall),
        const SizedBox(height: 4),
        if (versions.isEmpty) Text(l.flowNoVersions),
        for (final v in newestFirst)
          Card(
            key: ValueKey('version-${v['versionNumber']}'),
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        l.flowVersion(v['versionNumber'] as int),
                        style: theme.textTheme.titleSmall,
                      ),
                      const SizedBox(width: 8),
                      if (v['id'] == currentVersionId)
                        Chip(
                          label: Text(l.flowsPublished),
                          visualDensity: VisualDensity.compact,
                        ),
                    ],
                  ),
                  Text('${v['publishedAt']}', style: theme.textTheme.bodySmall),
                  Wrap(
                    spacing: 8,
                    children: [
                      if (v['id'] != currentVersionId && canRollback)
                        TextButton(
                          onPressed: () =>
                              onRollback(v['versionNumber'] as int),
                          child: Text(l.flowRollBackToThis),
                        ),
                      TextButton(
                        onPressed: () =>
                            onOpenAsDraft(v['versionNumber'] as int),
                        child: Text(l.flowOpenAsDraft),
                      ),
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

/// Confirms a publish, with what would change from the live version.
class PublishDialog extends StatelessWidget {
  const PublishDialog({
    super.key,
    required this.issues,
    required this.diff,
    required this.label,
    required this.liveVersion,
  });

  final List<FlowIssue> issues;
  final FlowDiff diff;

  /// A node's name for the summary, whether it still exists or not.
  final String Function(String id) label;
  final int? liveVersion;

  @override
  Widget build(BuildContext context) {
    final blocked = issues.isNotEmpty;
    final l10n = context.l10n;
    Widget group(String title, Iterable<String> lines) => lines.isEmpty
        ? const SizedBox.shrink()
        : Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleSmall),
                for (final l in lines) Text('• $l'),
              ],
            ),
          );
    return AlertDialog(
      title: Text(
        blocked ? l10n.flowFixBeforePublishing : l10n.flowPublishQuestion,
      ),
      content: SizedBox(
        width: 460,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (blocked)
                for (final i in issues) Text('• ${i.message}')
              else ...[
                Text(
                  liveVersion == null
                      ? l10n.flowFirstVersion
                      : diff.isEmpty
                      ? l10n.flowNothingChanged(liveVersion!)
                      : l10n.flowChangesSince(liveVersion!),
                ),
                group(l10n.flowDiffAdded, diff.added.map(label)),
                group(l10n.flowDiffRemoved, diff.removed.map(label)),
                group(l10n.flowDiffChanged, diff.changed.map(label)),
                group(l10n.flowDiffConnections, [
                  if (diff.connectionsAdded > 0)
                    l10n.flowDiffConnectionsAdded(diff.connectionsAdded),
                  if (diff.connectionsRemoved > 0)
                    l10n.flowDiffConnectionsRemoved(diff.connectionsRemoved),
                ]),
                group(l10n.flowDiffStarts, [
                  if (diff.entryPointsChanged) l10n.flowDiffChanged,
                ]),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(blocked ? l10n.commonClose : l10n.commonCancel),
        ),
        if (!blocked)
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.flowPublish),
          ),
      ],
    );
  }
}

/// A yes or no question.
Future<bool> confirm(
  BuildContext context, {
  required String title,
  required String body,
  required String action,
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(body),
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

/// Asks for the name of a new start.
Future<String?> askStartName(
  BuildContext context, {
  required String suggestion,
  required Set<String> taken,
}) => showDialog<String>(
  context: context,
  builder: (context) => _NameDialog(suggestion: suggestion, taken: taken),
);

class _NameDialog extends StatefulWidget {
  const _NameDialog({required this.suggestion, required this.taken});

  final String suggestion;
  final Set<String> taken;

  @override
  State<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends State<_NameDialog> {
  late final _name = TextEditingController(text: widget.suggestion);
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  void _submit() {
    final n = _name.text.trim();
    if (n.isEmpty) return setState(() => _error = context.l10n.flowEnterName);
    if (widget.taken.contains(n)) {
      return setState(() => _error = context.l10n.flowNameTaken);
    }
    Navigator.of(context).pop(n);
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(context.l10n.flowNameThisStart),
    content: TextField(
      controller: _name,
      autofocus: true,
      decoration: InputDecoration(
        labelText: context.l10n.fieldName,
        errorText: _error,
      ),
      onSubmitted: (_) => _submit(),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.of(context).pop(),
        child: Text(context.l10n.commonCancel),
      ),
      FilledButton(onPressed: _submit, child: Text(context.l10n.flowAdd)),
    ],
  );
}

/// A note shown in place of the properties form.
class PanelNote extends StatelessWidget {
  const PanelNote(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Text(text, textAlign: TextAlign.center),
    ),
  );
}

/// Shown while the flow loads or when it cannot.
class LoadFailure extends StatelessWidget {
  const LoadFailure(this.message, {super.key});

  final String message;

  @override
  Widget build(BuildContext context) => Center(child: ErrorText(message));
}
