import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../canvas/canvas.dart';
import '../../../widgets/page.dart';
import '../../pbx/pbx_api.dart';
import 'flow_graph.dart';
import 'flow_panels.dart';
import 'local_validation.dart';
import 'node_header.dart';
import 'node_types.dart';
import 'palette.dart';
import 'properties_panel.dart';

enum _SaveState { saved, dirty, saving, failed }

enum _Tab { properties, flow, history }

/// The visual editor for one call flow: a palette, the canvas, and a panel
/// for the selected step, the flow's starts and problems, and its history.
///
/// Edits are checked locally as they happen and the draft is saved a moment
/// after the last one. Publishing asks the service, which refuses a flow it
/// finds wrong.
class FlowBuilderPage extends ConsumerStatefulWidget {
  const FlowBuilderPage({super.key, required this.flowId});

  final String flowId;

  @override
  ConsumerState<FlowBuilderPage> createState() => _FlowBuilderPageState();
}

class _FlowBuilderPageState extends ConsumerState<FlowBuilderPage> {
  static const _autosaveDelay = Duration(milliseconds: 1200);

  late final _c = CanvasController(portsOf: flowPortsOf);
  PbxApi? _api;
  Json? _flow;
  List<Json> _versions = const [];
  var _entryPoints = <String, String>{};
  var _issues = <FlowIssue>[];
  List<FlowIssue>? _serviceIssues;
  var _save = _SaveState.saved;
  var _tab = _Tab.flow;
  String? _error;
  var _loading = true;

  Timer? _debounce;
  var _seenRevision = -1;
  var _token = 0;
  var _savedToken = 0;
  var _saving = false;

  @override
  void initState() {
    super.initState();
    _api = ref.read(pbxApiProvider);
    _c.addListener(_onCanvas);
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _c.removeListener(_onCanvas);
    // Leaving with edits the timer has not saved yet: save them now.
    if (_savedToken != _token && _flow != null) {
      unawaited(_saveNow(silent: true));
    }
    _c.dispose();
    super.dispose();
  }

  PbxApi get _client => _api!;

  // ---- loading --------------------------------------------------------

  Future<void> _load() async {
    try {
      final flow = await _client.get('flows', widget.flowId);
      final versions = await _versionList();
      if (!mounted) return;
      final graph = FlowGraph.fromJson(flow['draftGraph']);
      _replaceGraph(graph);
      setState(() {
        _flow = flow;
        _versions = versions;
        _entryPoints = {...graph.entryPoints};
        _issues = validateFlow(graph);
        _loading = false;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _c.fitToView();
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

  Future<List<Json>> _versionList() async {
    final body =
        await _client.call('GET', 'flows', widget.flowId, 'versions') as Map;
    return [
      for (final v in body['rows'] as List) (v as Map).cast<String, dynamic>(),
    ];
  }

  /// Puts [graph] on the canvas without counting it as an edit.
  void _replaceGraph(FlowGraph graph) {
    _c.removeListener(_onCanvas);
    _c.load(graph.nodes, graph.edges);
    _seenRevision = _c.revision;
    _c.addListener(_onCanvas);
  }

  // ---- edits ----------------------------------------------------------

  void _onCanvas() {
    if (_c.revision != _seenRevision) {
      _seenRevision = _c.revision;
      _touch();
    } else if (mounted) {
      setState(() {});
    }
  }

  /// The draft changed: recheck it, and save it soon.
  void _touch() {
    _token++;
    _debounce?.cancel();
    _debounce = Timer(_autosaveDelay, () => unawaited(_saveNow()));
    if (!mounted) return;
    setState(() {
      _serviceIssues = null;
      _issues = validateFlow(graphOf(_c, _entryPoints));
      _save = _SaveState.dirty;
    });
  }

  void _setEntryPoints(Map<String, String> next) {
    _entryPoints = next;
    _touch();
  }

  Future<bool> _saveNow({bool silent = false}) async {
    _debounce?.cancel();
    while (_saving) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    if (_savedToken == _token) return true;
    final token = _token;
    final body = graphOf(_c, _entryPoints).toJson();
    _saving = true;
    if (!silent && mounted) setState(() => _save = _SaveState.saving);
    try {
      await _client.call('PUT', 'flows', widget.flowId, 'draft', body: body);
      _savedToken = token;
      if (!silent && mounted) {
        setState(() {
          _error = null;
          _save = _token == token ? _SaveState.saved : _SaveState.dirty;
        });
        if (_token != token) {
          _debounce = Timer(_autosaveDelay, () => unawaited(_saveNow()));
        }
      }
      return true;
    } catch (e) {
      if (!silent && mounted) {
        setState(() {
          _save = _SaveState.failed;
          _error = 'Could not save: ${problemMessage(e)}';
        });
      }
      return false;
    } finally {
      _saving = false;
    }
  }

  void _add(FlowNodeType type, Offset at) {
    final node = _c.addNode(type.type, at, data: nodeData(type.defaults));
    // The first step is where calls start until the user says otherwise.
    if (_entryPoints.isEmpty) _setEntryPoints({'main': node.id});
    setState(() => _tab = _Tab.properties);
  }

  /// A step added from the palette by click goes near the middle of the view,
  /// each one a little further along so they do not stack.
  void _addAtCenter(FlowNodeType type) {
    final middle = _c.viewport.value.toCanvas(_c.viewSize.center(Offset.zero));
    final nudge = (_c.nodes.length % 6) * 30.0;
    _add(
      type,
      middle - const Offset(NodeMetrics.width / 2, 40) + Offset(nudge, nudge),
    );
  }

  Future<void> _makeStart(CanvasNode node) async {
    var suggestion = 'main';
    for (var i = 2; _entryPoints.containsKey(suggestion); i++) {
      suggestion = 'start$i';
    }
    final name = await askStartName(
      context,
      suggestion: suggestion,
      taken: _entryPoints.keys.toSet(),
    );
    if (name != null) _setEntryPoints({..._entryPoints, name: node.id});
  }

  // ---- service actions ------------------------------------------------

  Future<void> _validate() async {
    if (!await _saveNow()) return;
    try {
      final result =
          await _client.call('POST', 'flows', widget.flowId, 'validate') as Map;
      final issues = [
        for (final i in result['issues'] as List)
          FlowIssue(
            '${(i as Map)['kind']}',
            '${i['message']}',
            i['nodeId'] as String?,
          ),
      ];
      if (!mounted) return;
      setState(() {
        _serviceIssues = issues;
        _tab = _Tab.flow;
      });
      _say(
        issues.isEmpty
            ? 'The service says this flow is valid.'
            : 'The service found ${issues.length} problem(s).',
      );
    } catch (e) {
      _say(problemMessage(e));
    }
  }

  Future<FlowGraph?> _liveGraph() async {
    final live = _flow?['currentPublishedVersionId'];
    if (live == null) return null;
    final match = _versions.where((v) => v['id'] == live);
    if (match.isEmpty) return null;
    return _versionGraph(match.first['versionNumber'] as int);
  }

  Future<FlowGraph> _versionGraph(int number) async {
    final v = await _client.call(
      'GET',
      'flows',
      widget.flowId,
      'versions/$number',
    ) as Map;
    return FlowGraph.fromJson(v['graph']);
  }

  int? get _liveNumber {
    final live = _flow?['currentPublishedVersionId'];
    for (final v in _versions) {
      if (v['id'] == live) return v['versionNumber'] as int;
    }
    return null;
  }

  Future<void> _publish() async {
    if (!await _saveNow()) return;
    try {
      final graph = graphOf(_c, _entryPoints);
      final live = await _liveGraph();
      if (!mounted) return;
      final labels = {
        for (final n in [...?live?.nodes, ...graph.nodes]) n.id: nodeLabel(n),
      };
      final go = await showDialog<bool>(
        context: context,
        builder: (_) => PublishDialog(
          issues: validateFlow(graph),
          diff: diffGraphs(live, graph),
          label: (id) => labels[id] ?? id,
          liveVersion: _liveNumber,
        ),
      );
      if (go != true) return;
      final version =
          await _client.call('POST', 'flows', widget.flowId, 'publish') as Map;
      ref.invalidate(rowsProvider('flows'));
      await _refreshFlow();
      _say('Published version ${version['versionNumber']}.');
    } catch (e) {
      _say(problemMessage(e));
    }
  }

  Future<void> _refreshFlow() async {
    final flow = await _client.get('flows', widget.flowId);
    final versions = await _versionList();
    if (mounted) {
      setState(() {
        _flow = flow;
        _versions = versions;
      });
    }
  }

  Future<void> _rollback(int number) async {
    final ok = await confirm(
      context,
      title: 'Roll back to version $number?',
      body: 'Calls will use version $number again. Your draft is not changed.',
      action: 'Roll back',
    );
    if (!ok) return;
    try {
      await _client.call(
        'POST',
        'flows',
        widget.flowId,
        'rollback',
        body: {'versionNumber': number},
      );
      ref.invalidate(rowsProvider('flows'));
      await _refreshFlow();
      _say('Rolled back to version $number.');
    } catch (e) {
      _say(problemMessage(e));
    }
  }

  Future<void> _openAsDraft(int number) async {
    final ok = await confirm(
      context,
      title: 'Open version $number as the draft?',
      body:
          'The draft is replaced by version $number. Changes you have not published are lost.',
      action: 'Replace draft',
    );
    if (!ok) return;
    try {
      final graph = await _versionGraph(number);
      _replaceGraph(graph);
      _entryPoints = {...graph.entryPoints};
      _touch();
      _c.fitToView();
      _say('Draft replaced with version $number.');
    } catch (e) {
      _say(problemMessage(e));
    }
  }

  void _say(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  // ---- build ----------------------------------------------------------

  Map<String, List<FlowIssue>> get _issuesByNode {
    final map = <String, List<FlowIssue>>{};
    for (final i in _serviceIssues ?? _issues) {
      final id = i.nodeId;
      if (id != null) (map[id] ??= []).add(i);
    }
    return map;
  }

  List<String> _startNames(String nodeId) => [
    for (final e in _entryPoints.entries)
      if (e.value == nodeId) e.key,
  ];

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    final flow = _flow;
    if (flow == null) return LoadFailure(_error ?? 'Could not load this flow.');
    final byNode = _issuesByNode;
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _toolbar(flow),
          if (_error != null) ErrorText(_error!),
          const SizedBox(height: 8),
          Expanded(
            child: Card(
              clipBehavior: Clip.antiAlias,
              margin: EdgeInsets.zero,
              child: Row(
                children: [
                  SizedBox(width: 200, child: NodePalette(onAdd: _addAtCenter)),
                  const VerticalDivider(width: 1),
                  Expanded(
                    child: CanvasView(
                      controller: _c,
                      onDrop: (data, at) {
                        if (data is FlowNodeType) {
                          _add(
                            data,
                            at - const Offset(NodeMetrics.width / 2, 22),
                          );
                        }
                      },
                      header: (_, node) => NodeHeader(
                        node: node,
                        issues: byNode[node.id] ?? const [],
                        startNames: _startNames(node.id),
                      ),
                    ),
                  ),
                  const VerticalDivider(width: 1),
                  SizedBox(width: 340, child: _sidePanel(byNode)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _toolbar(Json flow) {
    final theme = Theme.of(context);
    final status = switch (_save) {
      _SaveState.saved => 'Saved',
      _SaveState.dirty => 'Unsaved changes',
      _SaveState.saving => 'Saving…',
      _SaveState.failed => 'Not saved',
    };
    final problems = (_serviceIssues ?? _issues).length;
    return Row(
      children: [
        IconButton(
          tooltip: 'Back to call flows',
          icon: const Icon(Icons.arrow_back),
          onPressed: () async {
            await _saveNow();
            if (mounted) context.go('/call-flows');
          },
        ),
        Expanded(
          child: Row(
            children: [
              Flexible(
                child: Text(
                  '${flow['name']}',
                  style: theme.textTheme.headlineSmall,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 12),
              Text(
                status,
                key: const ValueKey('save-status'),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: _save == _SaveState.failed
                      ? theme.colorScheme.error
                      : null,
                ),
              ),
              const SizedBox(width: 12),
              if (problems > 0)
                Chip(
                  key: const ValueKey('problem-count'),
                  avatar: Icon(
                    Icons.error_outline,
                    size: 16,
                    color: theme.colorScheme.error,
                  ),
                  label: Text('$problems'),
                  visualDensity: VisualDensity.compact,
                ),
            ],
          ),
        ),
        IconButton(
          tooltip: 'Undo',
          icon: const Icon(Icons.undo),
          onPressed: _c.canUndo ? _c.undo : null,
        ),
        IconButton(
          tooltip: 'Redo',
          icon: const Icon(Icons.redo),
          onPressed: _c.canRedo ? _c.redo : null,
        ),
        const SizedBox(width: 8),
        OutlinedButton(onPressed: _validate, child: const Text('Validate')),
        const SizedBox(width: 8),
        FilledButton(onPressed: _publish, child: const Text('Publish')),
      ],
    );
  }

  Widget _sidePanel(Map<String, List<FlowIssue>> byNode) {
    // A single selected step always shows its properties.
    final single = _c.selection.length == 1 && _tab != _Tab.history
        ? _c.nodes[_c.selection.single]
        : null;
    final tab = single != null ? _Tab.properties : _tab;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(8),
          child: SegmentedButton<_Tab>(
            showSelectedIcon: false,
            segments: const [
              ButtonSegment(value: _Tab.properties, label: Text('Step')),
              ButtonSegment(value: _Tab.flow, label: Text('Flow')),
              ButtonSegment(value: _Tab.history, label: Text('History')),
            ],
            selected: {tab},
            onSelectionChanged: (s) {
              setState(() => _tab = s.first);
              if (s.first != _Tab.properties) _c.clearSelection();
            },
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: switch (tab) {
            _Tab.properties =>
              single == null
                  ? PanelNote(
                      _c.selection.isEmpty
                          ? 'Select a step to edit it, or add one from the left.'
                          : '${_c.selection.length} steps selected.',
                    )
                  : NodeProperties(
                      key: ValueKey(single.id),
                      controller: _c,
                      node: single,
                      issues: byNode[single.id] ?? const [],
                      startNames: _startNames(single.id),
                      onMakeStart: () => _makeStart(single),
                    ),
            _Tab.flow => FlowPanel(
              nodes: _c.nodes,
              entryPoints: _entryPoints,
              issues: _serviceIssues ?? _issues,
              checkedByService: _serviceIssues != null,
              onEntryPoints: _setEntryPoints,
              onSelect: (id) {
                _c.select(id);
                setState(() => _tab = _Tab.properties);
              },
            ),
            _Tab.history => HistoryPanel(
              versions: _versions,
              currentVersionId: _flow?['currentPublishedVersionId'] as String?,
              onRollback: _rollback,
              onOpenAsDraft: _openAsDraft,
            ),
          },
        ),
      ],
    );
  }
}
