import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../canvas/canvas.dart';
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
    final type = flowNodeType(node.type);
    if (type == null) {
      return Text('Unknown step type "${node.type}".');
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
              tooltip: 'Delete this step',
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
            child: _editor(ref, f),
          ),
        if (node.type == 'menu') _menuOptions(theme),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: [
            for (final name in startNames)
              Chip(
                avatar: const Icon(Icons.flag_outlined, size: 16),
                label: Text('Start: $name'),
              ),
            OutlinedButton.icon(
              onPressed: onMakeStart,
              icon: const Icon(Icons.flag_outlined),
              label: const Text('Start a call here'),
            ),
          ],
        ),
        if (issues.isNotEmpty) ...[
          const SizedBox(height: 16),
          Text('Problems', style: theme.textTheme.titleSmall),
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

  Widget _editor(WidgetRef ref, ConfigField f) {
    final value = node.config[f.key];
    switch (f.kind) {
      case ConfigKind.ref:
        return _RefPicker(
          key: ValueKey('${node.id}:${f.key}'),
          label: f.label,
          resource: f.resource!,
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
          error: _numberError(f, value),
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
      case ConfigKind.timezone:
        final current = value as String?;
        final zones = [
          ...timezones,
          if (current != null && !timezones.contains(current)) current,
        ];
        return DropdownButtonFormField<String>(
          key: ValueKey('${node.id}:${f.key}'),
          initialValue: current,
          isExpanded: true,
          decoration: InputDecoration(labelText: f.label),
          items: [
            for (final z in zones) DropdownMenuItem(value: z, child: Text(z)),
          ],
          onChanged: (v) => _set(f.key, v),
        );
      case ConfigKind.flowEntry:
        final flowId = node.config['flowId'] as String?;
        if (flowId == null) {
          return InputDecorator(
            decoration: InputDecoration(
              labelText: f.label,
              helperText: 'Choose a call flow first.',
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
                helperText: list.isEmpty ? 'That flow has no start yet.' : null,
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

  String? _numberError(ConfigField f, Object? value) =>
      value is num && f.min != null && value < f.min!
      ? 'At least ${f.min}'
      : null;

  /// A menu's digit options: which keys the caller may press.
  Widget _menuOptions(ThemeData theme) {
    final open = node.openPorts;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Keys the caller may press', style: theme.textTheme.titleSmall),
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
        Text(
          'Each key you pick gets its own exit on the step. Unpicking one removes its connection.',
          style: theme.textTheme.bodySmall,
        ),
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
  });

  final String label;
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
        helper: 'Could not load the list (${problemMessage(e)}). Enter the id.',
        onCommit: (text) => onChanged(text.trim().isEmpty ? null : text.trim()),
      ),
      data: (map) {
        final current = value;
        return DropdownButtonFormField<String>(
          initialValue: current,
          isExpanded: true,
          decoration: InputDecoration(
            labelText: label,
            helperText: map.isEmpty ? 'None yet. Create one first.' : null,
          ),
          items: [
            for (final e in map.entries)
              DropdownMenuItem(value: e.key, child: Text(e.value)),
            if (current != null && !map.containsKey(current))
              DropdownMenuItem(
                value: current,
                child: Text('Missing ($current)'),
              ),
          ],
          onChanged: onChanged,
        );
      },
    );
  }
}

/// A text or number field that reports its value when it loses focus or is
/// submitted, so typing is one undo step rather than one per key.
class CommitField extends StatefulWidget {
  const CommitField({
    super.key,
    required this.label,
    required this.value,
    required this.onCommit,
    this.number = false,
    this.error,
    this.helper,
  });

  final String label;
  final String value;
  final void Function(String text) onCommit;
  final bool number;
  final String? error;
  final String? helper;

  @override
  State<CommitField> createState() => _CommitFieldState();
}

class _CommitFieldState extends State<CommitField> {
  late final _text = TextEditingController(text: widget.value);
  final _focus = FocusNode();

  /// The last text handed to [CommitField.onCommit], or the value it was
  /// given, so a submit followed by losing focus reports once.
  late String _committed = widget.value;

  @override
  void initState() {
    super.initState();
    _focus.addListener(() {
      if (!_focus.hasFocus) _commit();
    });
  }

  @override
  void didUpdateWidget(CommitField old) {
    super.didUpdateWidget(old);
    // Undo, redo, or another edit changed it; keep what is being typed.
    final changedUnderneath =
        widget.value != old.value && _text.text == old.value;
    if (widget.value != old.value) _committed = widget.value;
    if (widget.value != _text.text && (!_focus.hasFocus || changedUnderneath)) {
      _text.text = widget.value;
    }
  }

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _commit() {
    if (_text.text == _committed) return;
    _committed = _text.text;
    widget.onCommit(_text.text);
  }

  @override
  Widget build(BuildContext context) => TextField(
    controller: _text,
    focusNode: _focus,
    keyboardType: widget.number ? TextInputType.number : null,
    decoration: InputDecoration(
      labelText: widget.label,
      errorText: widget.error,
      helperText: widget.helper,
      helperMaxLines: 3,
    ),
    onSubmitted: (_) => _commit(),
  );
}
