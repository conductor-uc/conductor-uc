import '../../../canvas/canvas.dart';
import 'flow_graph.dart';
import 'node_types.dart';

/// One problem with a flow, in the shape of the service's own issues.
class FlowIssue {
  const FlowIssue(this.kind, this.message, [this.nodeId]);

  final String kind;
  final String message;
  final String? nodeId;
}

/// The checks `@cuc/callflow-ir` makes when a flow is validated or published,
/// run locally on every edit so problems show as badges at once. The service
/// stays the authority: it is asked on Validate, and refuses a bad publish.
/// A test holds this to the service's verdicts on a shared set of graphs.
///
/// Plus one check the service makes only when publishing, `incomplete_config`:
/// a setting that is still empty.
List<FlowIssue> validateFlow(FlowGraph graph) {
  final issues = <FlowIssue>[];
  final byId = <String, CanvasNode>{};
  final seen = <String>{};

  for (final node in graph.nodes) {
    if (!seen.add(node.id)) {
      issues.add(
        FlowIssue(
          'duplicate_node_id',
          "Node id '${node.id}' is used by more than one node.",
          node.id,
        ),
      );
    }
    byId[node.id] = node;
    if (flowNodeType(node.type) == null) {
      issues.add(
        FlowIssue(
          'bad_reference',
          "Node '${node.id}' has unknown type '${node.type}'.",
          node.id,
        ),
      );
    }
  }

  for (final e in graph.entryPoints.entries) {
    if (!byId.containsKey(e.value)) {
      issues.add(
        FlowIssue(
          'bad_reference',
          "Entry point '${e.key}' points to unknown node '${e.value}'.",
        ),
      );
    }
  }
  if (graph.entryPoints.isEmpty) {
    issues.add(
      const FlowIssue('missing_entry_point', 'The graph has no entry points.'),
    );
  }

  final counts = <String, int>{};
  for (final e in graph.edges) {
    final from = byId[e.from];
    if (from == null) {
      issues.add(
        FlowIssue('bad_reference', "Edge from unknown node '${e.from}'."),
      );
      continue;
    }
    if (!byId.containsKey(e.to)) {
      issues.add(
        FlowIssue(
          'bad_reference',
          "Edge '${e.from}.${e.port}' points to unknown node '${e.to}'.",
          e.from,
        ),
      );
    }
    final type = flowNodeType(from.type);
    if (type != null && !_allowedPorts(type).contains(e.port)) {
      issues.add(
        FlowIssue(
          'invalid_port',
          "Node '${e.from}' (${from.type}) has no port named '${e.port}'.",
          e.from,
        ),
      );
    }
    counts.update('${e.from}\u0000${e.port}', (n) => n + 1, ifAbsent: () => 1);
  }
  for (final entry in counts.entries) {
    if (entry.value <= 1) continue;
    final [nodeId, port] = entry.key.split('\u0000');
    issues.add(
      FlowIssue(
        menuDigits.contains(port) ? 'digit_conflict' : 'invalid_port',
        "Node '$nodeId' has ${entry.value} edges wired to port '$port'; a port may have at most one.",
        nodeId,
      ),
    );
  }

  for (final node in graph.nodes) {
    final type = flowNodeType(node.type);
    if (type == null) continue;
    final wired = {
      for (final e in graph.edges)
        if (e.from == node.id) e.port,
    };
    for (final port in type.ports) {
      if (!wired.contains(port.id)) {
        issues.add(
          FlowIssue(
            'missing_port',
            "Node '${node.id}' (${node.type}) is missing its required '${port.id}' port.",
            node.id,
          ),
        );
      }
    }
    // Saved before schedules existed: a time zone and no schedule.
    final legacy =
        node.type == 'time_condition' &&
        node.config.containsKey('timezone') &&
        !node.config.containsKey('scheduleId');
    if (legacy) {
      issues.add(
        FlowIssue(
          'invalid_config',
          "Node '${node.id}' (time_condition) was saved with a time zone and no schedule. Choose a schedule for it.",
          node.id,
        ),
      );
    }
    for (final field in type.fields) {
      if (legacy) break;
      final v = node.config[field.key];
      if (v == null || (v is String && v.trim().isEmpty)) {
        issues.add(
          FlowIssue(
            'incomplete_config',
            '${type.label}: choose ${field.label.toLowerCase()}.',
            node.id,
          ),
        );
      } else if (field.min != null && v is num && v < field.min!) {
        issues.add(
          FlowIssue(
            'incomplete_config',
            '${type.label}: ${field.label.toLowerCase()} must be at least ${field.min}.',
            node.id,
          ),
        );
      }
    }
  }

  final reachable = <String>{};
  final queue = [
    for (final id in graph.entryPoints.values)
      if (byId.containsKey(id)) id,
  ];
  for (var i = 0; i < queue.length; i++) {
    if (!reachable.add(queue[i])) continue;
    for (final e in graph.edges) {
      if (e.from == queue[i] && byId.containsKey(e.to)) queue.add(e.to);
    }
  }
  for (final node in graph.nodes) {
    if (!reachable.contains(node.id)) {
      issues.add(
        FlowIssue(
          'unreachable_node',
          "Node '${node.id}' is not reachable from any entry point.",
          node.id,
        ),
      );
    }
  }
  return issues;
}

List<String> _allowedPorts(FlowNodeType type) => [
  for (final p in type.ports) p.id,
  if (type.type == 'menu') ...menuDigits,
];
