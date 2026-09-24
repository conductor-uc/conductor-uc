import 'dart:convert';
import 'dart:io';

import 'package:console/canvas/canvas.dart';
import 'package:console/features/callflow/builder/flow_graph.dart';
import 'package:console/features/callflow/builder/local_validation.dart';
import 'package:console/features/callflow/builder/node_types.dart';
import 'package:flutter_test/flutter_test.dart';

/// `api/callflow-ir.json` is dumped from `@cuc/callflow-ir` by
/// `tool/dump-callflow-ir.mjs`. These tests hold the builder to it.
final _ir = jsonDecode(
  File('api/callflow-ir.json').readAsStringSync(),
) as Map<String, dynamic>;

Map<String, dynamic> _typeOf(String t) =>
    (_ir['nodeTypes'] as Map)[t] as Map<String, dynamic>;

void main() {
  group('node types match the IR', () {
    test('the same set of node types', () {
      expect({
        for (final t in flowNodeTypes) t.type,
      }, (_ir['nodeTypes'] as Map).keys.toSet());
    });

    for (final t in flowNodeTypes) {
      group(t.type, () {
        final ir = _typeOf(t.type);
        final config = ir['config'] as Map<String, dynamic>;
        final props = (config['properties'] as Map).cast<String, dynamic>();

        test('edits exactly the config the IR requires', () {
          final required = [...(config['required'] as List? ?? const [])];
          expect({for (final f in t.fields) f.key}, required.toSet());
          expect(props.keys.toSet(), required.toSet());
        });

        test('field kinds and minimums agree with the schema', () {
          for (final f in t.fields) {
            final p = props[f.key] as Map<String, dynamic>;
            switch (f.kind) {
              case ConfigKind.integer:
                expect(p['type'], 'number', reason: f.key);
                expect(p['minimum'], f.min, reason: f.key);
              case _:
                expect(p['type'], 'string', reason: f.key);
            }
          }
        });

        test('has the ports the IR requires', () {
          expect([for (final p in t.ports) p.id], ir['requiredPorts']);
        });

        test('defaults satisfy the schema minimums', () {
          for (final f in t.fields) {
            final d = t.defaults[f.key];
            if (f.kind == ConfigKind.integer) {
              expect(d, isA<int>(), reason: f.key);
              expect(d as int, greaterThanOrEqualTo(f.min ?? 0));
            }
          }
        });
      });
    }

    test('a menu offers exactly the digit ports the IR allows', () {
      const node = CanvasNode(
        id: 'm',
        type: 'menu',
        position: Offset.zero,
        data: {'config': {}, 'openPorts': menuDigits},
      );
      expect({
        for (final p in flowPortsOf(node)) p.id,
      }, (_typeOf('menu')['allowedPorts'] as List).toSet());
      expect(menuDigits.toSet(), (_ir['menuDigitPorts'] as List).toSet());
    });
  });

  group('local validation agrees with the service', () {
    for (final c in (_ir['cases'] as List).cast<Map<String, dynamic>>()) {
      test(c['name'] as String, () {
        final graph = FlowGraph.fromJson(c['graph']);
        final ours = {
          for (final i in validateFlow(graph))
            if (i.kind != 'incomplete_config') '${i.kind}:${i.nodeId ?? ''}',
        };
        final theirs = {
          for (final i in (c['issues'] as List).cast<Map<String, dynamic>>())
            '${i['kind']}:${i['nodeId'] ?? ''}',
        };
        expect(ours, theirs);
      });
    }
  });

  group('validation the service only does at publish', () {
    test('an empty setting is reported on its node', () {
      final graph = FlowGraph.fromJson({
        'entryPoints': {'main': 'p'},
        'nodes': [
          {
            'id': 'p',
            'type': 'play',
            'config': {'mediaAssetId': ''},
          },
        ],
        'edges': [],
      });
      final kinds = validateFlow(graph).map((i) => '${i.kind}:${i.nodeId}');
      expect(kinds, contains('incomplete_config:p'));
    });

    test('a number below its minimum is reported', () {
      final graph = FlowGraph.fromJson({
        'entryPoints': {'main': 'e'},
        'nodes': [
          {
            'id': 'e',
            'type': 'extension',
            'config': {'extensionId': 'x', 'ringSeconds': 0},
          },
        ],
        'edges': [],
      });
      expect(
        validateFlow(graph).map((i) => i.message),
        contains(contains('at least 1')),
      );
    });
  });

  group('FlowGraph', () {
    test('round trips the layout and open menu ports', () {
      final json = {
        'entryPoints': {'main': 'm'},
        'nodes': [
          {
            'id': 'm',
            'type': 'menu',
            'config': {
              'promptMediaAssetId': 'p',
              'timeoutSeconds': 5,
              'maxInvalidAttempts': 3,
            },
            'position': {'x': 120.0, 'y': 40.0},
            'openPorts': ['2'],
          },
        ],
        'edges': [],
      };
      final graph = FlowGraph.fromJson(json);
      expect(graph.nodes.single.position, const Offset(120, 40));
      expect(graph.nodes.single.openPorts, ['2']);
      expect(graph.toJson(), json);
    });

    test('a wired digit is shown even when it was not saved as open', () {
      final graph = FlowGraph.fromJson({
        'entryPoints': {'main': 'm'},
        'nodes': [
          {
            'id': 'm',
            'type': 'menu',
            'config': <String, dynamic>{},
            'position': {'x': 0, 'y': 0},
          },
          {'id': 'h', 'type': 'hangup', 'config': <String, dynamic>{}},
        ],
        'edges': [
          {'from': 'm', 'port': '7', 'to': 'h'},
        ],
      });
      expect(graph.nodes.first.openPorts, ['7']);
    });

    test('nodes with no saved position are laid out from the entry point', () {
      final graph = FlowGraph.fromJson({
        'entryPoints': {'main': 'a'},
        'nodes': [
          {'id': 'a', 'type': 'hangup', 'config': <String, dynamic>{}},
          {'id': 'b', 'type': 'hangup', 'config': <String, dynamic>{}},
          {'id': 'orphan', 'type': 'hangup', 'config': <String, dynamic>{}},
        ],
        'edges': [
          {'from': 'a', 'port': 'x', 'to': 'b'},
        ],
      });
      final at = {for (final n in graph.nodes) n.id: n.position};
      expect(at['a']!.dx, lessThan(at['b']!.dx));
      expect(at['b']!.dx, lessThan(at['orphan']!.dx));
      expect({at['a'], at['b'], at['orphan']}, hasLength(3));
    });

    test('reads a flow with nothing in it', () {
      final graph = FlowGraph.fromJson(null);
      expect(graph.nodes, isEmpty);
      expect(graph.entryPoints, isEmpty);
    });
  });

  group('diffGraphs', () {
    FlowGraph flow(
      List<Map<String, dynamic>> nodes, [
      List<List<String>> edges = const [],
    ]) => FlowGraph.fromJson({
      'entryPoints': {'main': nodes.first['id']},
      'nodes': [
        for (final n in nodes)
          {
            ...n,
            'position': {'x': 0, 'y': 0},
          },
      ],
      'edges': [
        for (final e in edges) {'from': e[0], 'port': e[1], 'to': e[2]},
      ],
    });
    Map<String, dynamic> ext(String id, {int ring = 20}) => {
      'id': id,
      'type': 'extension',
      'config': {'extensionId': 'x', 'ringSeconds': ring},
    };
    Map<String, dynamic> bye(String id) => {
      'id': id,
      'type': 'hangup',
      'config': <String, dynamic>{},
    };

    test('nothing published: everything is new', () {
      final d = diffGraphs(
        null,
        flow(
          [ext('a'), bye('b')],
          [
            ['a', 'noAnswer', 'b'],
          ],
        ),
      );
      expect(d.added, ['a', 'b']);
      expect(d.connectionsAdded, 1);
      expect(d.entryPointsChanged, isTrue);
    });

    test('identical graphs have no difference', () {
      final g = flow([ext('a')]);
      expect(diffGraphs(g, g).isEmpty, isTrue);
    });

    test('added, removed, and changed nodes, and connections', () {
      final before = flow(
        [ext('a'), bye('b')],
        [
          ['a', 'noAnswer', 'b'],
        ],
      );
      final after = flow(
        [ext('a', ring: 30), bye('c')],
        [
          ['a', 'noAnswer', 'c'],
        ],
      );
      final d = diffGraphs(before, after);
      expect(d.added, ['c']);
      expect(d.removed, ['b']);
      expect(d.changed, ['a']);
      expect(d.connectionsAdded, 1);
      expect(d.connectionsRemoved, 1);
      expect(d.entryPointsChanged, isFalse);
    });

    test('moving a node is not a change', () {
      final a = flow([ext('a')]);
      final moved = FlowGraph(
        nodes: [a.nodes.single.copyWith(position: const Offset(500, 500))],
        entryPoints: a.entryPoints,
      );
      expect(diffGraphs(a, moved).isEmpty, isTrue);
    });
  });
}
