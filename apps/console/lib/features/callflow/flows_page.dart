import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/permissions.dart';
import '../../forms/validators.dart';
import '../../l10n/l10n.dart';
import '../../widgets/data_table.dart';
import '../../widgets/feedback.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource_form.dart' show tenantCountryProvider;
import '../pbx/used_by.dart';
import 'flow_templates.dart';

/// Call flows (IVRs and auto-attendants): list, create from a template,
/// rename, copy, delete, and open in the builder (S9-10).
class FlowsPage extends ConsumerWidget {
  const FlowsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final rows = ref.watch(rowsProvider('flows'));
    final canEdit = ref.watch(canProvider('callflow.edit'));
    final canDelete = ref.watch(canProvider('callflow.publish'));
    // Which numbers each flow answers, so the list says what is live.
    final numbers = ref.watch(rowsProvider('dids')).asData?.value ?? const [];
    final country = ref.watch(tenantCountryProvider);
    List<String> numbersOf(Json flow) => [
      for (final d in numbers)
        if (d['destinationType'] == 'flow' && d['destinationId'] == flow['id'])
          formatPhone('${d['e164']}', country: country),
    ];
    final newButton = FilledButton.icon(
      onPressed: () => _create(context, ref),
      icon: const Icon(Icons.add),
      label: Text(l10n.resNew('flows')),
    );

    return PageFrame(
      children: [
        PageHeader(
          title: l10n.cfPlural,
          subtitle: l10n.flowsSubtitle,
          actions: [if (canEdit) newButton],
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody<List<Json>>(
            value: rows,
            empty: EmptyState(
              icon: Icons.account_tree_outlined,
              title: l10n.resEmpty('flows'),
              message: l10n.flowsEmptyBody,
              action: canEdit ? newButton : null,
            ),
            builder: (data) => SingleChildScrollView(
              child: AppTable<Json>(
                rows: data,
                rowKey: (f) => '${f['id']}',
                initialSort: 0,
                columns: [
                  AppColumn(
                    label: l10n.fieldName,
                    cell: (f) => TextButton(
                      onPressed: () => context.go('/call-flows/${f['id']}'),
                      child: Text('${f['name']}'),
                    ),
                    text: (f) => '${f['name']}',
                  ),
                  AppColumn(
                    label: l10n.flowsStatus,
                    cell: (f) => Text(_status(l10n, f)),
                    text: (f) => _status(l10n, f),
                  ),
                  AppColumn(
                    label: l10n.flowsAnswers,
                    cell: (f) {
                      final list = numbersOf(f);
                      return Text(list.isEmpty ? '—' : list.join(', '));
                    },
                    text: (f) => numbersOf(f).join(', '),
                  ),
                ],
                actions: (f) => [
                  IconButton(
                    tooltip: l10n.flowsOpen,
                    icon: const Icon(Icons.open_in_new),
                    onPressed: () => context.go('/call-flows/${f['id']}'),
                  ),
                  if (canEdit) ...[
                    IconButton(
                      tooltip: l10n.flowsRename,
                      icon: const Icon(Icons.drive_file_rename_outline),
                      onPressed: () => _rename(context, ref, f),
                    ),
                    IconButton(
                      tooltip: l10n.flowsDuplicate,
                      icon: const Icon(Icons.copy_outlined),
                      onPressed: () => _duplicate(context, ref, f),
                    ),
                  ],
                  if (canDelete)
                    IconButton(
                      tooltip: l10n.commonDelete,
                      icon: const Icon(Icons.delete_outline),
                      onPressed: () => _delete(context, ref, f),
                    ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  static String _status(AppLocalizations l10n, Json f) =>
      f['currentPublishedVersionId'] == null
      ? l10n.flowsNotPublished
      : l10n.flowsPublished;

  Future<void> _create(BuildContext context, WidgetRef ref) async {
    final api = ref.read(pbxApiProvider);
    final messenger = ScaffoldMessenger.of(context);
    final choice = await showDialog<(String, FlowTemplate)>(
      context: context,
      builder: (_) => const _NewFlowDialog(),
    );
    if (choice == null || api == null) return;
    final (name, template) = choice;
    try {
      final flow = await api.create('flows', {'name': name});
      if (template.graph != null) {
        await api.saveFlowDraft('${flow['id']}', template.graph!);
      }
      ref.invalidate(rowsProvider('flows'));
      if (context.mounted) context.go('/call-flows/${flow['id']}');
    } catch (e) {
      showToast(messenger, problemMessage(e));
    }
  }

  Future<void> _rename(BuildContext context, WidgetRef ref, Json flow) async {
    final api = ref.read(pbxApiProvider);
    final messenger = ScaffoldMessenger.of(context);
    final name = await showDialog<String>(
      context: context,
      builder: (_) => _NameDialog(
        title: context.l10n.flowsRename,
        initial: '${flow['name']}',
        action: context.l10n.commonSave,
      ),
    );
    if (name == null || api == null) return;
    try {
      await api.update('flows', '${flow['id']}', {'name': name});
      ref.invalidate(rowsProvider('flows'));
      showToast(messenger, currentL10n.commonSaved);
    } catch (e) {
      showToast(messenger, problemMessage(e));
    }
  }

  /// A copy of the flow's current draft, under a new name, to try changes
  /// without touching the one that answers calls.
  Future<void> _duplicate(
    BuildContext context,
    WidgetRef ref,
    Json flow,
  ) async {
    final api = ref.read(pbxApiProvider);
    final messenger = ScaffoldMessenger.of(context);
    if (api == null) return;
    try {
      final full = await api.get('flows', '${flow['id']}');
      final copy = await api.create('flows', {
        'name': currentL10n.flowsCopyName('${flow['name']}'),
      });
      final draft = full['draftGraph'];
      if (draft is Map) {
        await api.saveFlowDraft('${copy['id']}', draft.cast<String, dynamic>());
      }
      ref.invalidate(rowsProvider('flows'));
      showToast(messenger, currentL10n.flowsCopied('${copy['name']}'));
    } catch (e) {
      showToast(messenger, problemMessage(e));
    }
  }

  Future<void> _delete(BuildContext context, WidgetRef ref, Json flow) async {
    final api = ref.read(pbxApiProvider);
    final messenger = ScaffoldMessenger.of(context);
    final l10n = context.l10n;
    final uses = await usedBy(ref, 'flows', '${flow['id']}');
    if (!context.mounted) return;
    final confirmed = await confirmAction(
      context,
      title: l10n.resDeleteTitle('flows'),
      message: '${flow['name']}',
      impact: uses,
      confirmLabel: l10n.commonDelete,
    );
    if (!confirmed || api == null) return;
    try {
      await api.delete('flows', '${flow['id']}');
      ref.invalidate(rowsProvider('flows'));
      showToast(messenger, currentL10n.commonDeleted);
    } catch (e) {
      showToast(messenger, problemMessage(e));
    }
  }
}

/// A name and a starting point for a new flow.
class _NewFlowDialog extends StatefulWidget {
  const _NewFlowDialog();

  @override
  State<_NewFlowDialog> createState() => _NewFlowDialogState();
}

class _NewFlowDialogState extends State<_NewFlowDialog> {
  final _name = TextEditingController();
  String _template = 'blank';

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final templates = flowTemplates(l10n);
    return AlertDialog(
      title: Text(l10n.resNew('flows')),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              key: const ValueKey('flow-name'),
              controller: _name,
              autofocus: true,
              decoration: InputDecoration(labelText: l10n.fieldName),
              onSubmitted: (_) => _submit(templates),
            ),
            const SizedBox(height: 16),
            Text(l10n.flowsStartFrom),
            RadioGroup<String>(
              groupValue: _template,
              onChanged: (v) => setState(() => _template = v ?? 'blank'),
              child: Column(
                children: [
                  for (final t in templates)
                    RadioListTile<String>(
                      contentPadding: EdgeInsets.zero,
                      value: t.id,
                      title: Text(t.title),
                      subtitle: Text(t.description),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.commonCancel),
        ),
        FilledButton(
          onPressed: () => _submit(templates),
          child: Text(l10n.flowsCreate),
        ),
      ],
    );
  }

  void _submit(List<FlowTemplate> templates) {
    final name = _name.text.trim();
    if (name.isEmpty) return;
    Navigator.of(context)
        .pop((name, templates.firstWhere((t) => t.id == _template)));
  }
}

class _NameDialog extends StatefulWidget {
  const _NameDialog({
    required this.title,
    required this.initial,
    required this.action,
  });

  final String title;
  final String initial;
  final String action;

  @override
  State<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends State<_NameDialog> {
  late final _name = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        controller: _name,
        autofocus: true,
        decoration: InputDecoration(labelText: context.l10n.fieldName),
        onSubmitted: (_) => _submit(),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(context.l10n.commonCancel),
        ),
        FilledButton(onPressed: _submit, child: Text(widget.action)),
      ],
    );
  }

  void _submit() {
    final name = _name.text.trim();
    if (name.isNotEmpty) Navigator.of(context).pop(name);
  }
}
