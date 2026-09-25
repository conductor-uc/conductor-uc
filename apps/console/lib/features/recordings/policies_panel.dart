import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource.dart';
import 'recordings_api.dart';

/// Which resource a policy scope picks its target from.
const _scopeResource = {
  'extension': 'extensions',
  'queue': 'queues',
  'did': 'dids',
};

const _scopeNoun = {
  'extension': 'extension',
  'queue': 'queue',
  'did': 'phone number',
};

String _titleFor(String scopeType, Json row) => switch (scopeType) {
  'extension' => extensionsDef.titleOf(row),
  'queue' => queuesDef.titleOf(row),
  _ => didsDef.titleOf(row),
};

/// The recording rules: what is recorded, announced, and for how long it is
/// kept. Needs `recording.policy.manage`.
class PoliciesPanel extends ConsumerWidget {
  const PoliciesPanel({super.key});

  String _appliesTo(Json p, WidgetRef ref) {
    final type = '${p['scopeType']}';
    if (type == 'tenant') return 'Whole organization';
    final rows =
        ref.watch(rowsProvider(_scopeResource[type]!)).asData?.value ??
        const <Json>[];
    final match = rows.where((r) => r['id'] == p['scopeId']);
    final noun = policyScopes[type] ?? type;
    return match.isEmpty
        ? '$noun ${p['scopeId']}'
        : '$noun ${_titleFor(type, match.first)}';
  }

  Future<void> _edit(
    BuildContext context,
    WidgetRef ref, [
    Json? policy,
  ]) async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (_) => PolicyDialog(policy: policy),
    );
    if (saved == true) ref.invalidate(recordingPoliciesProvider);
  }

  Future<void> _delete(BuildContext context, WidgetRef ref, Json p) async {
    final api = ref.read(recordingsApiProvider);
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete rule?'),
        content: Text(
          'Calls it covered follow the next broader rule, or are not recorded '
          'if there is none. ${_appliesTo(p, ref)}.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || api == null) return;
    try {
      await api.deletePolicy('${p['id']}');
      ref.invalidate(recordingPoliciesProvider);
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text('Could not delete it: ${problemMessage(e)}')),
      );
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final policies = ref.watch(recordingPoliciesProvider);
    final canChange = ref.watch(canProvider('recording.policy.manage'));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const RetentionCard(),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: Text(
                'The narrowest rule that applies to a call decides: an '
                'extension beats a queue, a queue beats a phone number, a phone '
                'number beats the whole organization. With no rule, a call is '
                'not recorded.',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
            if (canChange) ...[
              const SizedBox(width: 12),
              FilledButton.icon(
                onPressed: () => _edit(context, ref),
                icon: const Icon(Icons.add),
                label: const Text('Add rule'),
              ),
            ],
          ],
        ),
        const SizedBox(height: 12),
        Expanded(
          child: AsyncBody<List<Json>>(
            value: policies,
            emptyText: 'No rules yet, so no calls are recorded.',
            builder: (rows) => SingleChildScrollView(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: DataTable(
                  columns: const [
                    DataColumn(label: Text('Applies to')),
                    DataColumn(label: Text('Calls')),
                    DataColumn(label: Text('Action')),
                    DataColumn(label: Text('Announcement')),
                    DataColumn(label: Text('')),
                  ],
                  rows: [
                    for (final p in rows)
                      DataRow(
                        key: ValueKey('policy-${p['id']}'),
                        cells: [
                          DataCell(Text(_appliesTo(p, ref))),
                          DataCell(
                            Text(
                              policyDirections['${p['direction']}'] ??
                                  '${p['direction']}',
                            ),
                          ),
                          DataCell(
                            Text(
                              policyActions['${p['action']}'] ??
                                  '${p['action']}',
                            ),
                          ),
                          DataCell(
                            Text(
                              p['announce'] != true
                                  ? 'None'
                                  : p['consentAssetId'] == null
                                  ? 'Short tone'
                                  : 'Recording',
                            ),
                          ),
                          DataCell(
                            Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (canChange) ...[
                                  IconButton(
                                    tooltip: 'Edit rule',
                                    icon: const Icon(Icons.edit_outlined),
                                    onPressed: () => _edit(context, ref, p),
                                  ),
                                  IconButton(
                                    tooltip: 'Delete rule',
                                    icon: const Icon(Icons.delete_outline),
                                    onPressed: () => _delete(context, ref, p),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        ],
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// How long recordings are kept before they are deleted.
class RetentionCard extends ConsumerStatefulWidget {
  const RetentionCard({super.key});

  @override
  ConsumerState<RetentionCard> createState() => _RetentionCardState();
}

class _RetentionCardState extends ConsumerState<RetentionCard> {
  final _days = TextEditingController();
  bool _loaded = false;
  bool _busy = false;
  String? _error;
  String? _notice;

  @override
  void dispose() {
    _days.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final days = int.tryParse(_days.text.trim());
    if (days == null || days < 0 || days > 3650) {
      setState(() {
        _error = 'Enter a whole number of days from 0 to 3650.';
        _notice = null;
      });
      return;
    }
    final api = ref.read(recordingsApiProvider);
    if (api == null) return;
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final saved = await api.saveRetentionDays(days);
      ref.invalidate(recordingRetentionProvider);
      ref.invalidate(recordingListProvider);
      if (mounted) {
        setState(() {
          _busy = false;
          _notice = saved == 0
              ? 'Recordings are now kept until they are deleted.'
              : 'Recordings are now kept for $saved days.';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = problemMessage(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final current = ref.watch(recordingRetentionProvider);
    final canChange = ref.watch(canProvider('recording.policy.manage'));
    if (!_loaded && current.hasValue) {
      _loaded = true;
      _days.text = '${current.requireValue}';
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Keeping recordings',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 12,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                SizedBox(
                  width: 240,
                  child: TextField(
                    key: const ValueKey('retention-days'),
                    controller: _days,
                    enabled: !_busy,
                    readOnly: !canChange,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'Keep recordings for (days)',
                      helperText: '0 keeps them until someone deletes them.',
                    ),
                    onSubmitted: (_) => _save(),
                  ),
                ),
                if (canChange)
                  FilledButton(
                    onPressed: _busy ? null : _save,
                    child: const Text('Save'),
                  ),
              ],
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              ErrorText(_error!),
            ],
            if (_notice != null) ...[const SizedBox(height: 8), Text(_notice!)],
          ],
        ),
      ),
    );
  }
}

/// Adds a rule, or changes [policy].
class PolicyDialog extends ConsumerStatefulWidget {
  const PolicyDialog({super.key, this.policy});

  final Json? policy;

  @override
  ConsumerState<PolicyDialog> createState() => _PolicyDialogState();
}

class _PolicyDialogState extends ConsumerState<PolicyDialog> {
  late PolicyForm _form;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final policy = widget.policy;
    _form = policy == null ? const PolicyForm() : PolicyForm.fromPolicy(policy);
  }

  void _set({
    String? scopeType,
    String? Function()? scopeId,
    String? direction,
    String? action,
    bool? announce,
    String? Function()? consent,
  }) {
    setState(() {
      _form = PolicyForm(
        scopeType: scopeType ?? _form.scopeType,
        scopeId: scopeId != null ? scopeId() : _form.scopeId,
        direction: direction ?? _form.direction,
        action: action ?? _form.action,
        announce: announce ?? _form.announce,
        consentAssetId: consent != null ? consent() : _form.consentAssetId,
      );
    });
  }

  Future<void> _save() async {
    if (_form.scopeType != 'tenant' && _form.scopeId == null) {
      setState(
        () => _error = 'Choose which ${_scopeNoun[_form.scopeType]} it covers.',
      );
      return;
    }
    final api = ref.read(recordingsApiProvider);
    if (api == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final policy = widget.policy;
      if (policy == null) {
        await api.createPolicy(_form);
      } else {
        await api.savePolicy('${policy['id']}', _form);
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = problemMessage(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final targets = _form.scopeType == 'tenant'
        ? const <Json>[]
        : ref
                  .watch(rowsProvider(_scopeResource[_form.scopeType]!))
                  .asData
                  ?.value ??
              const <Json>[];
    final assets = [
      for (final a
          in ref.watch(rowsProvider('media-assets')).asData?.value ??
              const <Json>[])
        if (a['status'] == 'ready' && a['kind'] == 'prompt') a,
    ];
    final recording = _form.action == 'record';
    return AlertDialog(
      title: Text(widget.policy == null ? 'Add rule' : 'Edit rule'),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DropdownButtonFormField<String>(
                key: const ValueKey('policy-scope'),
                initialValue: _form.scopeType,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Applies to'),
                items: [
                  for (final e in policyScopes.entries)
                    DropdownMenuItem(value: e.key, child: Text(e.value)),
                ],
                onChanged: _busy
                    ? null
                    : (v) => _set(scopeType: v, scopeId: () => null),
              ),
              if (_form.scopeType != 'tenant')
                DropdownButtonFormField<String>(
                  key: ValueKey('policy-target-${_form.scopeType}'),
                  initialValue: _form.scopeId,
                  isExpanded: true,
                  decoration: InputDecoration(
                    labelText: policyScopes[_form.scopeType],
                  ),
                  items: [
                    for (final t in targets)
                      DropdownMenuItem(
                        value: '${t['id']}',
                        child: Text(_titleFor(_form.scopeType, t)),
                      ),
                  ],
                  onChanged: _busy ? null : (v) => _set(scopeId: () => v),
                ),
              DropdownButtonFormField<String>(
                key: const ValueKey('policy-direction'),
                initialValue: _form.direction,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Calls'),
                items: [
                  for (final e in policyDirections.entries)
                    DropdownMenuItem(value: e.key, child: Text(e.value)),
                ],
                onChanged: _busy ? null : (v) => _set(direction: v),
              ),
              DropdownButtonFormField<String>(
                key: const ValueKey('policy-action'),
                initialValue: _form.action,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Action'),
                items: [
                  for (final e in policyActions.entries)
                    DropdownMenuItem(value: e.key, child: Text(e.value)),
                ],
                onChanged: _busy
                    ? null
                    : (v) => _set(
                        action: v,
                        announce: v == 'record' ? null : false,
                        consent: v == 'record' ? null : () => null,
                      ),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Play an announcement first'),
                subtitle: const Text(
                  'Played to the caller before recording starts.',
                ),
                value: _form.announce && recording,
                onChanged: _busy || !recording
                    ? null
                    : (v) => _set(announce: v, consent: () => null),
              ),
              if (_form.announce && recording)
                DropdownButtonFormField<String?>(
                  key: const ValueKey('policy-consent'),
                  initialValue: _form.consentAssetId,
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: 'Announcement recording',
                    helperText:
                        'Upload a prompt on the Media page. Without one, a '
                        'short tone plays instead of words.',
                  ),
                  items: [
                    const DropdownMenuItem(
                      value: null,
                      child: Text('Short tone'),
                    ),
                    for (final a in assets)
                      DropdownMenuItem(
                        value: '${a['id']}',
                        child: Text('${a['label']}'),
                      ),
                  ],
                  onChanged: _busy ? null : (v) => _set(consent: () => v),
                ),
              const SizedBox(height: 8),
              Text(
                'Whether you must tell people a call is recorded, and how, '
                'depends on where they are. Choosing announcements that meet '
                'those rules is up to you.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                ErrorText(_error!),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: const Text('Save'),
        ),
      ],
    );
  }
}
