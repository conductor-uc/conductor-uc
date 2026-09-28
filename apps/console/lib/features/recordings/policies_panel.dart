import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../l10n/l10n.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource.dart';
import 'recordings_api.dart';

/// Which resource a policy scope picks its target from.
/// An agent rule names the agent's extension.
const _scopeResource = {
  'extension': 'extensions',
  'agent': 'extensions',
  'queue': 'queues',
  'did': 'dids',
};

String _titleFor(String scopeType, Json row) => switch (scopeType) {
  'extension' || 'agent' => extensionsDef.titleOf(row),
  'queue' => queuesDef.titleOf(row),
  _ => didsDef.titleOf(row),
};

/// The recording rules: what is recorded, announced, and for how long it is
/// kept. Needs `recording.policy.manage`.
class PoliciesPanel extends ConsumerWidget {
  const PoliciesPanel({super.key});

  String _appliesTo(AppLocalizations l10n, Json p, WidgetRef ref) {
    final type = '${p['scopeType']}';
    if (type == 'tenant') return l10n.polScopeTenant;
    final rows =
        ref.watch(rowsProvider(_scopeResource[type]!)).asData?.value ??
        const <Json>[];
    final match = rows.where((r) => r['id'] == p['scopeId']);
    final noun = policyScopesOf(l10n)[type] ?? type;
    return match.isEmpty
        ? l10n.polAppliesToTarget(noun, '${p['scopeId']}')
        : l10n.polAppliesToTarget(noun, _titleFor(type, match.first));
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
    final l10n = context.l10n;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.polDeleteTitle),
        content: Text(l10n.polDeleteBody(_appliesTo(l10n, p, ref))),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.commonCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.commonDelete),
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
        SnackBar(content: Text(l10n.polCouldNotDelete(problemMessage(e)))),
      );
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final policies = ref.watch(recordingPoliciesProvider);
    final canChange = ref.watch(canProvider('recording.policy.manage'));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const RetentionCard(),
        const SizedBox(height: 16),
        const RecordingRequiredCard(),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: Text(
                l10n.polPrecedence,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
            if (canChange) ...[
              const SizedBox(width: 12),
              FilledButton.icon(
                onPressed: () => _edit(context, ref),
                icon: const Icon(Icons.add),
                label: Text(l10n.polAdd),
              ),
            ],
          ],
        ),
        const SizedBox(height: 12),
        Expanded(
          child: AsyncBody<List<Json>>(
            value: policies,
            emptyText: l10n.polEmpty,
            builder: (rows) => SingleChildScrollView(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: DataTable(
                  columns: [
                    DataColumn(label: Text(l10n.polAppliesTo)),
                    DataColumn(label: Text(l10n.polCalls)),
                    DataColumn(label: Text(l10n.polAction)),
                    DataColumn(label: Text(l10n.polAnnouncement)),
                    DataColumn(label: Text(l10n.polFeatureCodes)),
                    const DataColumn(label: Text('')),
                  ],
                  rows: [
                    for (final p in rows)
                      DataRow(
                        key: ValueKey('policy-${p['id']}'),
                        cells: [
                          DataCell(Text(_appliesTo(l10n, p, ref))),
                          DataCell(
                            Text(
                              policyDirectionsOf(l10n)['${p['direction']}'] ??
                                  '${p['direction']}',
                            ),
                          ),
                          DataCell(
                            Text(
                              policyActionsOf(l10n)['${p['action']}'] ??
                                  '${p['action']}',
                            ),
                          ),
                          DataCell(
                            Text(
                              p['announce'] != true
                                  ? l10n.polAnnounceNone
                                  : p['consentAssetId'] == null
                                  ? l10n.polShortTone
                                  : l10n.polAnnounceRecording,
                            ),
                          ),
                          DataCell(
                            Text(
                              p['allowOnDemand'] != true
                                  ? l10n.polCodesOff
                                  : p['action'] == 'record'
                                  ? l10n.polCodesPause
                                  : l10n.polCodesRecord,
                            ),
                          ),
                          DataCell(
                            Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (canChange) ...[
                                  IconButton(
                                    tooltip: l10n.polEdit,
                                    icon: const Icon(Icons.edit_outlined),
                                    onPressed: () => _edit(context, ref, p),
                                  ),
                                  IconButton(
                                    tooltip: l10n.polDelete,
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
        _error = context.l10n.polRetentionInvalid;
        _notice = null;
      });
      return;
    }
    final api = ref.read(recordingsApiProvider);
    if (api == null) return;
    final l10n = context.l10n;
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final saved = await api.saveRetentionDays(days);
      ref.invalidate(recordingSettingsProvider);
      ref.invalidate(recordingListProvider);
      if (mounted) {
        setState(() {
          _busy = false;
          _notice = saved == 0
              ? l10n.polKeptUntilDeleted
              : l10n.polKeptForDays(saved);
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
    final l10n = context.l10n;
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
              l10n.polKeepingTitle,
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
                    decoration: InputDecoration(
                      labelText: l10n.polKeepFor,
                      helperText: l10n.polKeepForHelp,
                    ),
                    onSubmitted: (_) => _save(),
                  ),
                ),
                if (canChange)
                  FilledButton(
                    onPressed: _busy ? null : _save,
                    child: Text(l10n.commonSave),
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

/// Whether calls are refused when their recording cannot be set up
/// ("recording required", fail closed). Off by default: a call then goes
/// ahead unrecorded and is flagged.
class RecordingRequiredCard extends ConsumerStatefulWidget {
  const RecordingRequiredCard({super.key});

  @override
  ConsumerState<RecordingRequiredCard> createState() =>
      _RecordingRequiredCardState();
}

class _RecordingRequiredCardState extends ConsumerState<RecordingRequiredCard> {
  bool _busy = false;
  String? _error;
  String? _notice;

  Future<void> _save(bool required) async {
    final api = ref.read(recordingsApiProvider);
    if (api == null) return;
    final l10n = context.l10n;
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final saved = await api.saveRecordingRequired(required);
      ref.invalidate(recordingSettingsProvider);
      if (mounted) {
        setState(() {
          _busy = false;
          _notice = saved ? l10n.polRequiredOn : l10n.polRequiredOff;
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
    final l10n = context.l10n;
    final settings = ref.watch(recordingSettingsProvider);
    final canChange = ref.watch(canProvider('recording.policy.manage'));
    final required = settings.asData?.value.recordingRequired ?? false;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SwitchListTile(
              key: const ValueKey('recording-required'),
              contentPadding: EdgeInsets.zero,
              title: Text(l10n.polRequiredTitle),
              subtitle: Text(l10n.polRequiredHelp),
              value: required,
              onChanged: _busy || !canChange || !settings.hasValue
                  ? null
                  : _save,
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
    bool? allowOnDemand,
  }) {
    setState(() {
      _form = PolicyForm(
        scopeType: scopeType ?? _form.scopeType,
        scopeId: scopeId != null ? scopeId() : _form.scopeId,
        direction: direction ?? _form.direction,
        action: action ?? _form.action,
        announce: announce ?? _form.announce,
        consentAssetId: consent != null ? consent() : _form.consentAssetId,
        allowOnDemand: allowOnDemand ?? _form.allowOnDemand,
      );
    });
  }

  Future<void> _save() async {
    if (_form.scopeType != 'tenant' && _form.scopeId == null) {
      setState(() => _error = context.l10n.polChooseTarget(_form.scopeType));
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
    final l10n = context.l10n;
    final recording = _form.action == 'record';
    final agentRule = _form.scopeType == 'agent';
    return AlertDialog(
      title: Text(widget.policy == null ? l10n.polAdd : l10n.polEdit),
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
                decoration: InputDecoration(labelText: l10n.polAppliesTo),
                items: [
                  for (final e in policyScopesOf(l10n).entries)
                    DropdownMenuItem(value: e.key, child: Text(e.value)),
                ],
                onChanged: _busy
                    ? null
                    : (v) => v == 'agent'
                          // An agent rule only records, with no announcement
                          // and no feature codes: the service refuses others.
                          ? _set(
                              scopeType: v,
                              scopeId: () => null,
                              action: 'record',
                              announce: false,
                              consent: () => null,
                              allowOnDemand: false,
                            )
                          : _set(scopeType: v, scopeId: () => null),
              ),
              if (agentRule)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    l10n.polAgentHelp,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              if (_form.scopeType != 'tenant')
                DropdownButtonFormField<String>(
                  key: ValueKey('policy-target-${_form.scopeType}'),
                  initialValue: _form.scopeId,
                  isExpanded: true,
                  decoration: InputDecoration(
                    labelText: policyScopesOf(l10n)[_form.scopeType],
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
                decoration: InputDecoration(labelText: l10n.polCalls),
                items: [
                  for (final e in policyDirectionsOf(l10n).entries)
                    DropdownMenuItem(value: e.key, child: Text(e.value)),
                ],
                onChanged: _busy ? null : (v) => _set(direction: v),
              ),
              DropdownButtonFormField<String>(
                key: const ValueKey('policy-action'),
                initialValue: _form.action,
                isExpanded: true,
                decoration: InputDecoration(labelText: l10n.polAction),
                items: [
                  for (final e in policyActionsOf(l10n).entries)
                    if (!agentRule || e.key == 'record')
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
                title: Text(l10n.polAnnounceFirst),
                subtitle: Text(l10n.polAnnounceFirstHelp),
                value: _form.announce && recording,
                onChanged: _busy || !recording || agentRule
                    ? null
                    : (v) => _set(announce: v, consent: () => null),
              ),
              if (_form.announce && recording)
                DropdownButtonFormField<String?>(
                  key: const ValueKey('policy-consent'),
                  initialValue: _form.consentAssetId,
                  isExpanded: true,
                  decoration: InputDecoration(
                    labelText: l10n.polAnnouncementRecording,
                    helperText: l10n.polAnnouncementHelp,
                  ),
                  items: [
                    DropdownMenuItem(
                      value: null,
                      child: Text(l10n.polShortTone),
                    ),
                    for (final a in assets)
                      DropdownMenuItem(
                        value: '${a['id']}',
                        child: Text('${a['label']}'),
                      ),
                  ],
                  onChanged: _busy ? null : (v) => _set(consent: () => v),
                ),
              if (!agentRule)
                SwitchListTile(
                  key: const ValueKey('policy-on-demand'),
                  contentPadding: EdgeInsets.zero,
                  title: Text(
                    recording ? l10n.polAllowPause : l10n.polAllowOnDemand,
                  ),
                  subtitle: Text(
                    recording
                        ? l10n.polAllowPauseHelp
                        : l10n.polAllowOnDemandHelp,
                  ),
                  value: _form.allowOnDemand,
                  onChanged: _busy ? null : (v) => _set(allowOnDemand: v),
                ),
              const SizedBox(height: 8),
              Text(
                l10n.polDisclosure,
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
          child: Text(l10n.commonCancel),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: Text(l10n.commonSave),
        ),
      ],
    );
  }
}
