import 'dart:convert';
import 'dart:ui';

import '../../../canvas/canvas.dart';
import 'node_types.dart';

/// A flow as the service stores it: nodes, connections, and named entry
/// points, with the editor's layout beside each node.
class FlowGraph {
  const FlowGraph({
    this.nodes = const [],
    this.edges = const [],
    this.entryPoints = const {},
  });

  final List<CanvasNode> nodes;
  final List<CanvasEdge> edges;
  final Map<String, String> entryPoints;

  /// Reads the service's graph. Nodes with no saved position (a flow written
  /// by hand or by an API client) are laid out left to right from the entry
  /// points.
  factory FlowGraph.fromJson(Object? json) {
    final map = json is Map ? json.cast<String, dynamic>() : const {};
    final rawNodes = [
      for (final n in (map['nodes'] as List?) ?? const [])
        (n as Map).cast<String, dynamic>(),
    ];
    final edges = [
      for (final e in (map['edges'] as List?) ?? const [])
        CanvasEdge(
          (e as Map)['from'] as String,
          e['port'] as String,
          e['to'] as String,
        ),
    ];
    final entryPoints = {
      for (final e in ((map['entryPoints'] as Map?) ?? const {}).entries)
        '${e.key}': '${e.value}',
    };
    final laid = _layout(rawNodes, edges, entryPoints);
    final nodes = <CanvasNode>[];
    for (final n in rawNodes) {
      final id = n['id'] as String;
      final type = n['type'] as String;
      final open = {
        for (final p in (n['openPorts'] as List?) ?? const []) '$p',
        // A menu shows every digit that is wired, whether or not it was saved
        // as open.
        if (type == 'menu')
          for (final e in edges)
            if (e.from == id && menuDigits.contains(e.port)) e.port,
      };
      final pos = n['position'];
      nodes.add(
        CanvasNode(
          id: id,
          type: type,
          position: pos is Map
              ? Offset(
                  (pos['x'] as num).toDouble(),
                  (pos['y'] as num).toDouble(),
                )
              : laid[id] ?? Offset.zero,
          data: nodeData(
            ((n['config'] as Map?) ?? const {}).cast<String, dynamic>(),
            [
              for (final d in menuDigits)
                if (open.contains(d)) d,
            ],
          ),
        ),
      );
    }
    return FlowGraph(nodes: nodes, edges: edges, entryPoints: entryPoints);
  }

  /// The body of `PUT .../draft`.
  Map<String, dynamic> toJson() => {
    'entryPoints': entryPoints,
    'nodes': [
      for (final n in nodes)
        {
          'id': n.id,
          'type': n.type,
          'config': n.config,
          'position': {'x': n.position.dx, 'y': n.position.dy},
          if (n.openPorts.isNotEmpty) 'openPorts': n.openPorts,
        },
    ],
    'edges': [
      for (final e in edges) {'from': e.from, 'port': e.port, 'to': e.to},
    ],
  };

  static Map<String, Offset> _layout(
    List<Map<String, dynamic>> nodes,
    List<CanvasEdge> edges,
    Map<String, String> entryPoints,
  ) {
    final unplaced = [
      for (final n in nodes)
        if (n['position'] is! Map) n['id'] as String,
    ];
    if (unplaced.isEmpty) return const {};
    // Depth from the entry points, breadth first; unreachable nodes go last.
    final depth = <String, int>{};
    final queue = <String>[...entryPoints.values.toSet()];
    for (final id in queue) {
      depth[id] = 0;
    }
    for (var i = 0; i < queue.length; i++) {
      for (final e in edges) {
        if (e.from == queue[i] && !depth.containsKey(e.to)) {
          depth[e.to] = depth[queue[i]]! + 1;
          queue.add(e.to);
        }
      }
    }
    final maxDepth = depth.values.fold(0, (a, b) => a > b ? a : b);
    final rows = <int, int>{};
    final at = <String, Offset>{};
    for (final id in unplaced) {
      final d = depth[id] ?? maxDepth + 1;
      final row = rows[d] = (rows[d] ?? -1) + 1;
      at[id] = Offset(60.0 + d * 320, 60.0 + row * 200);
    }
    return at;
  }
}

/// A canvas and its entry points as a [FlowGraph].
FlowGraph graphOf(CanvasController c, Map<String, String> entryPoints) =>
    FlowGraph(
      nodes: c.nodes.values.toList(),
      edges: c.edges,
      entryPoints: entryPoints,
    );

// ---- what changed between two graphs ------------------------------------

/// A summary of how one graph differs from another, for the publish dialog.
/// Layout is not behavior, so moving a node is not a change.
class FlowDiff {
  const FlowDiff({
    this.added = const [],
    this.removed = const [],
    this.changed = const [],
    this.connectionsAdded = 0,
    this.connectionsRemoved = 0,
    this.entryPointsChanged = false,
  });

  final List<String> added;
  final List<String> removed;
  final List<String> changed;
  final int connectionsAdded;
  final int connectionsRemoved;
  final bool entryPointsChanged;

  bool get isEmpty =>
      added.isEmpty &&
      removed.isEmpty &&
      changed.isEmpty &&
      connectionsAdded == 0 &&
      connectionsRemoved == 0 &&
      !entryPointsChanged;
}

String _canonical(Object? v) => jsonEncode(_sorted(v));

Object? _sorted(Object? v) => v is Map
    ? {for (final k in (v.keys.toList()..sort())) k: _sorted(v[k])}
    : v is List
    ? [for (final x in v) _sorted(x)]
    : v;

/// How [next] differs from [previous] (null when nothing was published yet).
FlowDiff diffGraphs(FlowGraph? previous, FlowGraph next) {
  final before = {for (final n in previous?.nodes ?? <CanvasNode>[]) n.id: n};
  final after = {for (final n in next.nodes) n.id: n};
  String key(CanvasEdge e) => '${e.from}\u0000${e.port}\u0000${e.to}';
  final oldEdges = {for (final e in previous?.edges ?? <CanvasEdge>[]) key(e)};
  final newEdges = {for (final e in next.edges) key(e)};
  return FlowDiff(
    added: [
      for (final id in after.keys)
        if (!before.containsKey(id)) id,
    ],
    removed: [
      for (final id in before.keys)
        if (!after.containsKey(id)) id,
    ],
    changed: [
      for (final id in after.keys)
        if (before[id] != null &&
            (before[id]!.type != after[id]!.type ||
                _canonical(before[id]!.config) !=
                    _canonical(after[id]!.config)))
          id,
    ],
    connectionsAdded: newEdges.difference(oldEdges).length,
    connectionsRemoved: oldEdges.difference(newEdges).length,
    entryPointsChanged:
        _canonical(previous?.entryPoints ?? const {}) !=
        _canonical(next.entryPoints),
  );
}
