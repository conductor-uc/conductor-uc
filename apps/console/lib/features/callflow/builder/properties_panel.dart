import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../canvas/canvas.dart';
import '../../../l10n/l10n.dart';
import '../../../widgets/commit_field.dart';
import '../../../widgets/page.dart';
import '../../pbx/pbx_api.dart';
import 'local_validation.dart';
import 'lookups.dart';
import 'node_types.dart';

/// The typed form for one node: a picker or field per setting of its type.
/// Each edit is one undo step on the canvas.
class NodeProperties extends ConsumerWidget {
  const NodeProperties({
    super.key,
    required this.controller,
    required this.node,
    required this.issues,
    required this.startNames,
    required this.onMakeStart,
  });

  final CanvasController controller;
  final CanvasNode node;
  final List<FlowIssue> issues;
  final List<String> startNames;
  final VoidCallback onMakeStart;

  void _set(String key, Object? value, {Map<String, Object?> also = const {}}) {
    controller.setData(
      node.id,
      nodeData({...node.config, key: value, ...also}, node.openPorts),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final l = context.l10n;
    final type = flowNodeType(node.type);
    if (type == null) {
      return Text(l.flowUnknownStepType(node.type));
    }
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Row(
          children: [
            Icon(type.icon),
            const SizedBox(width: 8),
            Expanded(
              child: Text(type.label, style: theme.textTheme.titleMedium),
            ),
            IconButton(
              tooltip: l.flowDeleteStep,
              icon: const Icon(Icons.delete_outline),
              onPressed: controller.deleteSelection,
            ),
          ],
        ),
        Text(type.description, style: theme.textTheme.bodySmall),
        const SizedBox(height: 16),
        for (final f in type.fields)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: _editor(l, ref, f),
          ),
        if (node.type == 'menu') _menuOptions(l, theme),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: [
            for (final name in startNames)
              Chip(
                avatar: const Icon(Icons.flag_outlined, size: 16),
                label: Text(l.flowStartName(name)),
              ),
            OutlinedButton.icon(
              onPressed: onMakeStart,
              icon: const Icon(Icons.flag_outlined),
              label: Text(l.flowStartCallHere),
            ),
          ],
        ),
        if (issues.isNotEmpty) ...[
          const SizedBox(height: 16),
          Text(l.flowProblems, style: theme.textTheme.titleSmall),
          for (final i in issues)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.error_outline,
                    size: 16,
                    color: theme.colorScheme.error,
                  ),
                  const SizedBox(width: 6),
                  Expanded(child: Text(i.message)),
                ],
              ),
            ),
        ],
      ],
    );
  }

  Widget _editor(AppLocalizations l, WidgetRef ref, ConfigField f) {
    final value = node.config[f.key];
    switch (f.kind) {
      case ConfigKind.ref:
        return _RefPicker(
          key: ValueKey('${node.id}:${f.key}'),
          label: f.label,
          resource: f.resource!,
          help: f.help,
          value: value as String?,
          onChanged: (v) => _set(
            f.key,
            v,
            // A different flow has different entry points.
            also: f.key == 'flowId' ? {'entryPoint': null} : const {},
          ),
        );
      case ConfigKind.integer:
        return CommitField(
          key: ValueKey('${node.id}:${f.key}'),
          label: f.label,
          value: value == null ? '' : '$value',
          number: true,
          error: _numberError(l, f, value),
          onCommit: (text) {
            final n = int.tryParse(text.trim());
            if (n != null) _set(f.key, n);
          },
        );
      case ConfigKind.text:
        return CommitField(
          key: ValueKey('${node.id}:${f.key}'),
          label: f.label,
          value: '${value ?? ''}',
          onCommit: (text) => _set(f.key, text.trim()),
        );
      case ConfigKind.flowEntry:
        final flowId = node.config['flowId'] as String?;
        if (flowId == null) {
          return InputDecorator(
            decoration: InputDecoration(
              labelText: f.label,
              helperText: l.flowChooseFlowFirst,
            ),
            child: const SizedBox(height: 20),
          );
        }
        final names = ref.watch(flowEntryPointsProvider(flowId));
        return names.when(
          loading: () => const LinearProgressIndicator(),
          error: (e, _) => ErrorText(problemMessage(e)),
          data: (list) {
            final current = value as String?;
            final options = [
              ...list,
              if (current != null && !list.contains(current)) current,
            ];
            return DropdownButtonFormField<String>(
              key: ValueKey('${node.id}:${f.key}:$flowId'),
              initialValue: current,
              isExpanded: true,
              decoration: InputDecoration(
                labelText: f.label,
                helperText: list.isEmpty ? l.flowNoStartYet : null,
              ),
              items: [
                for (final n in options)
                  DropdownMenuItem(value: n, child: Text(n)),
              ],
              onChanged: (v) => _set(f.key, v),
            );
          },
        );
    }
  }

  String? _numberError(AppLocalizations l, ConfigField f, Object? value) =>
      value is num && f.min != null && value < f.min!
      ? l.flowAtLeast(f.min!)
      : null;

  /// A menu's digit options: which keys the caller may press.
  Widget _menuOptions(AppLocalizations l, ThemeData theme) {
    final open = node.openPorts;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(l.flowMenuKeys, style: theme.textTheme.titleSmall),
        const SizedBox(height: 4),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final d in menuDigits)
              FilterChip(
                key: ValueKey('digit-$d'),
                label: Text(d),
                selected: open.contains(d),
                onSelected: (on) => controller.setData(
                  node.id,
                  nodeData(node.config, [
                    for (final k in menuDigits)
                      if (k == d ? on : open.contains(k)) k,
                  ]),
                ),
              ),
          ],
        ),
        const SizedBox(height: 4),
        Text(l.flowMenuKeysHelp, style: theme.textTheme.bodySmall),
      ],
    );
  }
}

/// A dropdown of a tenant's rows of one resource. When the list cannot be
/// loaded (a reseller acting as a tenant cannot read mailboxes, say) it falls
/// back to typing the id.
class _RefPicker extends ConsumerWidget {
  const _RefPicker({
    super.key,
    required this.label,
    required this.resource,
    required this.value,
    required this.onChanged,
    this.help,
  });

  final String label;
  final String? help;
  final String resource;
  final String? value;
  final void Function(String?) onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final options = ref.watch(optionsProvider(resource));
    return options.when(
      loading: () => InputDecorator(
        decoration: InputDecoration(labelText: label),
        child: const LinearProgressIndicator(),
      ),
      error: (e, _) => CommitField(
        label: label,
        value: value ?? '',
        helper: context.l10n.flowRefLoadFailed(problemMessage(e)),
        onCommit: (text) => onChanged(text.trim().isEmpty ? null : text.trim()),
      ),
      data: (map) {
        final current = value;
        return DropdownButtonFormField<String>(
          initialValue: current,
          isExpanded: true,
          decoration: InputDecoration(
            labelText: label,
            helperText: map.isEmpty ? context.l10n.flowRefNone : help,
            helperMaxLines: 3,
          ),
          items: [
            for (final e in map.entries)
              DropdownMenuItem(value: e.key, child: Text(e.value)),
            if (current != null && !map.containsKey(current))
              DropdownMenuItem(
                value: current,
                child: Text(context.l10n.flowRefMissing(current)),
              ),
          ],
          onChanged: onChanged,
        );
      },
    );
  }
}
