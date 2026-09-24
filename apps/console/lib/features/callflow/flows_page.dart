import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';

/// Call flows (IVRs and auto-attendants): list, create, and open. The visual
/// builder is S3-09 and S3-10; until then a flow's graph is edited as JSON.
class FlowsPage extends ConsumerWidget {
  const FlowsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(tenantIdProvider) == null) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Text(
          'Choose a tenant to configure. Acting as a tenant arrives with the app shell.',
        ),
      );
    }
    final rows = ref.watch(rowsProvider('flows'));
    return PageFrame(
      children: [
        PageHeader(
          title: 'Call flows',
          subtitle: 'Menus, time-of-day routing, and other call handling a number can point at.',
          actions: [
            FilledButton.icon(
              onPressed: () => _create(context, ref),
              icon: const Icon(Icons.add),
              label: const Text('New call flow'),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody(
            value: rows,
            emptyText: 'No call flows yet.',
            builder: (data) => Material(
              type: MaterialType.transparency,
              child: ListView(
                children: [
                  for (final flow in data)
                    ListTile(
                      leading: const Icon(Icons.account_tree_outlined),
                      title: Text('${flow['name']}'),
                      subtitle: Text(
                        flow['currentPublishedVersionId'] == null
                            ? 'Not published'
                            : 'Published',
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => context.go('/call-flows/${flow['id']}'),
                    ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _create(BuildContext context, WidgetRef ref) async {
    final api = ref.read(pbxApiProvider);
    final name = await showDialog<String>(
      context: context,
      builder: (_) => const _NameDialog(),
    );
    if (name == null || api == null) return;
    try {
      final flow = await api.create('flows', {'name': name});
      ref.invalidate(rowsProvider('flows'));
      if (context.mounted) context.go('/call-flows/${flow['id']}');
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(problemMessage(e))));
      }
    }
  }
}

class _NameDialog extends StatefulWidget {
  const _NameDialog();

  @override
  State<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends State<_NameDialog> {
  final _name = TextEditingController();

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('New call flow'),
      content: TextField(
        controller: _name,
        autofocus: true,
        decoration: const InputDecoration(labelText: 'Name'),
        onSubmitted: (_) => _submit(),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Create')),
      ],
    );
  }

  void _submit() {
    final name = _name.text.trim();
    if (name.isNotEmpty) Navigator.of(context).pop(name);
  }
}

const _starterGraph = {
  'entryPoints': <String, String>{},
  'nodes': <Object>[],
  'edges': <Object>[],
};

/// One flow: its draft graph as JSON, with validate, save, publish, and the
/// published versions.
class FlowEditorPage extends ConsumerStatefulWidget {
  const FlowEditorPage({super.key, required this.flowId});

  final String flowId;

  @override
  ConsumerState<FlowEditorPage> createState() => _FlowEditorPageState();
}

class _FlowEditorPageState extends ConsumerState<FlowEditorPage> {
  final _graph = TextEditingController();
  Json? _flow;
  List<Json> _versions = const [];
  List<Json> _issues = const [];
  String? _status;
  String? _error;
  bool _loading = true;

  static const _encoder = JsonEncoder.withIndent('  ');

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _graph.dispose();
    super.dispose();
  }

  PbxApi get _api => ref.read(pbxApiProvider)!;

  Future<void> _load() async {
    try {
      final flow = await _api.get('flows', widget.flowId);
      final versions =
          await _api.call('GET', 'flows', widget.flowId, 'versions') as Map;
      if (!mounted) return;
      setState(() {
        _flow = flow;
        _graph.text = _encoder.convert(flow['draftGraph'] ?? _starterGraph);
        _versions = [
          for (final v in versions['rows'] as List)
            (v as Map).cast<String, dynamic>(),
        ];
        _loading = false;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = problemMessage(e);
          _loading = false;
        });
      }
    }
  }

  Object? _parseGraph() {
    try {
      return jsonDecode(_graph.text);
    } on FormatException catch (e) {
      setState(() => _error = 'The graph is not valid JSON: ${e.message}');
      return null;
    }
  }

  Future<void> _run(String working, Future<String?> Function() action) async {
    setState(() {
      _error = null;
      _status = working;
    });
    try {
      final done = await action();
      if (mounted) setState(() => _status = done);
    } catch (e) {
      if (mounted) {
        setState(() {
          _status = null;
          _error = problemMessage(e);
        });
      }
    }
  }

  Future<String?> _save() async {
    final graph = _parseGraph();
    if (graph == null) return null;
    await _api.call('PUT', 'flows', widget.flowId, 'draft', body: graph);
    return 'Draft saved.';
  }

  Future<String?> _validate() async {
    final saved = await _save();
    if (saved == null) return null;
    final result =
        await _api.call('POST', 'flows', widget.flowId, 'validate') as Map;
    final issues = [
      for (final i in result['issues'] as List)
        (i as Map).cast<String, dynamic>(),
    ];
    setState(() => _issues = issues);
    return issues.isEmpty
        ? 'The flow is valid.'
        : '${issues.length} problem(s) found.';
  }

  Future<String?> _publish() async {
    final saved = await _save();
    if (saved == null) return null;
    final version =
        await _api.call('POST', 'flows', widget.flowId, 'publish') as Map;
    ref.invalidate(rowsProvider('flows'));
    await _load();
    return 'Published version ${version['versionNumber']}.';
  }

  Future<String?> _rollback(int versionNumber) async {
    await _api.call(
      'POST',
      'flows',
      widget.flowId,
      'rollback',
      body: {'versionNumber': versionNumber},
    );
    ref.invalidate(rowsProvider('flows'));
    await _load();
    return 'Rolled back to version $versionNumber.';
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final flow = _flow;
    return Padding(
      padding: const EdgeInsets.all(24),
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    IconButton(
                      tooltip: 'Back to call flows',
                      icon: const Icon(Icons.arrow_back),
                      onPressed: () => context.go('/call-flows'),
                    ),
                    Expanded(
                      child: Text(
                        flow == null ? 'Call flow' : '${flow['name']}',
                        style: textTheme.headlineSmall,
                      ),
                    ),
                    OutlinedButton(
                      onPressed: flow == null
                          ? null
                          : () => _run('Saving…', _save),
                      child: const Text('Save draft'),
                    ),
                    const SizedBox(width: 8),
                    OutlinedButton(
                      onPressed: flow == null
                          ? null
                          : () => _run('Checking…', _validate),
                      child: const Text('Validate'),
                    ),
                    const SizedBox(width: 8),
                    FilledButton(
                      onPressed: flow == null
                          ? null
                          : () => _run('Publishing…', _publish),
                      child: const Text('Publish'),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                const Text(
                  'The visual builder is coming; for now the flow graph is edited as JSON.',
                ),
                if (_status != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(_status!),
                  ),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: ErrorText(_error!),
                  ),
                const SizedBox(height: 12),
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        flex: 3,
                        child: TextField(
                          controller: _graph,
                          expands: true,
                          maxLines: null,
                          minLines: null,
                          textAlignVertical: TextAlignVertical.top,
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 13,
                          ),
                          decoration: const InputDecoration(
                            border: OutlineInputBorder(),
                            labelText: 'Flow graph',
                          ),
                        ),
                      ),
                      const SizedBox(width: 16),
                      SizedBox(
                        width: 260,
                        child: ListView(
                          children: [
                            Text('Problems', style: textTheme.titleSmall),
                            if (_issues.isEmpty) const Text('None found.'),
                            for (final issue in _issues)
                              ListTile(
                                dense: true,
                                contentPadding: EdgeInsets.zero,
                                leading: const Icon(
                                  Icons.error_outline,
                                  size: 18,
                                ),
                                title: Text('${issue['message']}'),
                                subtitle: issue['nodeId'] == null
                                    ? null
                                    : Text('Node ${issue['nodeId']}'),
                              ),
                            const SizedBox(height: 16),
                            Text(
                              'Published versions',
                              style: textTheme.titleSmall,
                            ),
                            if (_versions.isEmpty) const Text('None yet.'),
                            for (final v in _versions)
                              ListTile(
                                dense: true,
                                contentPadding: EdgeInsets.zero,
                                title: Text('Version ${v['versionNumber']}'),
                                subtitle: Text('${v['publishedAt']}'),
                                trailing: TextButton(
                                  onPressed: () => _run(
                                    'Rolling back…',
                                    () => _rollback(v['versionNumber'] as int),
                                  ),
                                  child: const Text('Roll back'),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
    );
  }
}
