import 'dart:ui';

import 'package:console/canvas/canvas.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

void main() {
  late CanvasController c;
  setUp(() => c = newController());
  tearDown(() => c.dispose());

  CanvasNode step(Offset at) => c.addNode('step', at);

  group('nodes', () {
    test('a new node is snapped to the grid and selected', () {
      final n = step(const Offset(33, 47));
      expect(n.position, const Offset(40, 40));
      expect(c.selection, {n.id});
    });

    test('ids are unique', () {
      final ids = {for (var i = 0; i < 20; i++) step(Offset.zero).id};
      expect(ids, hasLength(20));
    });

    test('moving snaps, and the whole move is one undo step', () {
      final n = step(const Offset(100, 100));
      c.beginMove();
      c.moveBy(const Offset(13, 7));
      c.moveBy(const Offset(53, 21));
      c.endMove();
      expect(c.nodes[n.id]!.position, const Offset(160, 120));
      c.undo();
      expect(c.nodes[n.id]!.position, const Offset(100, 100));
    });

    test('a move that goes nowhere records nothing', () {
      step(const Offset(100, 100));
      final before = c.canUndo;
      c.undo();
      c.redo();
      c.beginMove();
      c.moveBy(const Offset(2, 2));
      c.endMove();
      expect(before, isTrue);
      // Only the redo of the add remains undoable.
      c.undo();
      expect(c.nodes, isEmpty);
    });

    test('moving takes every selected node together', () {
      final a = step(const Offset(0, 0));
      final b = step(const Offset(200, 0));
      c.selectAll();
      c.beginMove();
      c.moveBy(const Offset(40, 60));
      c.endMove();
      expect(c.nodes[a.id]!.position, const Offset(40, 60));
      expect(c.nodes[b.id]!.position, const Offset(240, 60));
    });
  });

  group('edges', () {
    test('connects an output port to another node', () {
      final a = step(Offset.zero);
      final b = step(const Offset(300, 0));
      expect(c.connect(a.id, 'a', b.id), isTrue);
      expect(c.edges, [CanvasEdge(a.id, 'a', b.id)]);
    });

    test('refuses a loop, an unknown port, an unknown node, a repeat', () {
      final a = step(Offset.zero);
      final b = step(const Offset(300, 0));
      expect(c.connect(a.id, 'a', a.id), isFalse);
      expect(c.connect(a.id, 'zzz', b.id), isFalse);
      expect(c.connect(a.id, 'a', 'nope'), isFalse);
      final end = c.addNode('end', const Offset(600, 0));
      expect(
        c.connect(end.id, 'a', a.id),
        isFalse,
        reason: 'an end has no ports',
      );
      c.connect(a.id, 'a', b.id);
      expect(c.connect(a.id, 'a', b.id), isFalse);
    });

    test('connecting a used port replaces its connection', () {
      final a = step(Offset.zero);
      final b = step(const Offset(300, 0));
      final d = step(const Offset(300, 200));
      c.connect(a.id, 'a', b.id);
      c.connect(a.id, 'a', d.id);
      expect(c.edges, [CanvasEdge(a.id, 'a', d.id)]);
    });

    test('a port may keep several connections when configured to', () {
      final many = CanvasController(
        portsOf: testPorts,
        singleEdgePerPort: false,
      );
      final a = many.addNode('step', Offset.zero);
      final b = many.addNode('step', const Offset(300, 0));
      final d = many.addNode('step', const Offset(300, 200));
      many.connect(a.id, 'a', b.id);
      many.connect(a.id, 'a', d.id);
      expect(many.edges, hasLength(2));
      many.dispose();
    });

    test('deleting a node deletes its connections', () {
      final a = step(Offset.zero);
      final b = step(const Offset(300, 0));
      c.connect(a.id, 'a', b.id);
      c.select(b.id);
      c.deleteSelection();
      expect(c.nodes.keys, [a.id]);
      expect(c.edges, isEmpty);
      c.undo();
      expect(c.edges, hasLength(1));
    });

    test('a selected connection is deleted on its own', () {
      final a = step(Offset.zero);
      final b = step(const Offset(300, 0));
      c.connect(a.id, 'a', b.id);
      c.selectEdge(c.edges.single);
      c.deleteSelection();
      expect(c.edges, isEmpty);
      expect(c.nodes, hasLength(2));
    });
  });

  test(
    'a data change that removes a port drops the connections leaving it',
    () {
      // `portsOf` here gives a node with `open` in its data an extra port.
      final c = CanvasController(
        portsOf: (n) => [
          const CanvasPort('a', 'A'),
          if (n.data['open'] == true) const CanvasPort('x', 'X'),
        ],
      );
      final a = c.addNode('step', Offset.zero, data: {'open': true});
      final b = c.addNode('step', const Offset(300, 0));
      c.connect(a.id, 'x', b.id);
      c.connect(a.id, 'a', b.id);
      c.setData(a.id, {'open': false});
      expect(c.edges, [CanvasEdge(a.id, 'a', b.id)]);
      c.undo();
      expect(c.edges, hasLength(2));
      c.dispose();
    },
  );

  group('selection', () {
    test('select, add to, and toggle', () {
      final a = step(Offset.zero);
      final b = step(const Offset(300, 0));
      c.select(a.id);
      c.select(b.id, additive: true);
      expect(c.selection, {a.id, b.id});
      c.select(a.id, additive: true);
      expect(c.selection, {b.id});
    });

    test('a marquee selects what it touches', () {
      final a = step(Offset.zero);
      step(const Offset(1000, 1000));
      c.clearSelection();
      c.marquee(const Rect.fromLTWH(-10, -10, 100, 100));
      expect(c.selection, {a.id});
    });

    test('an additive marquee keeps the selection', () {
      final a = step(Offset.zero);
      final b = step(const Offset(1000, 1000));
      c.select(b.id);
      c.marquee(const Rect.fromLTWH(-10, -10, 100, 100), additive: true);
      expect(c.selection, {a.id, b.id});
    });
  });

  group('clipboard', () {
    test('paste copies nodes and the connections between them', () {
      final a = step(Offset.zero);
      final b = step(const Offset(300, 0));
      final outside = step(const Offset(600, 0));
      c.connect(a.id, 'a', b.id);
      c.connect(b.id, 'a', outside.id);
      c.marquee(const Rect.fromLTWH(-10, -10, 600, 200));
      expect(c.selection, {a.id, b.id});
      c.copy();
      c.paste();

      expect(c.nodes, hasLength(5));
      expect(c.selection, hasLength(2));
      expect(c.selection.intersection({a.id, b.id}), isEmpty);
      final pasted = c.edges.where((e) => c.selection.contains(e.from));
      expect(pasted, hasLength(1));
      expect(c.selection.contains(pasted.single.to), isTrue);
      // The connection out of the copied group is not copied.
      expect(c.edges, hasLength(3));
    });

    test('pasted nodes are offset and their data is independent', () {
      final n = c.addNode('step', Offset.zero, data: {'k': 1});
      c.copy();
      c.paste();
      final copy = c.nodes[c.selection.single]!;
      expect(copy.position, isNot(n.position));
      expect(copy.data, {'k': 1});
      c.setData(copy.id, {'k': 2});
      expect(c.nodes[n.id]!.data, {'k': 1});
    });

    test('paste is one undo step', () {
      step(Offset.zero);
      c.copy();
      c.paste();
      c.undo();
      expect(c.nodes, hasLength(1));
    });
  });

  group('undo and redo', () {
    test('walks back and forward through edits', () {
      final a = step(Offset.zero);
      c.setData(a.id, {'x': 1});
      c.setData(a.id, {'x': 2});
      c.undo();
      expect(c.nodes[a.id]!.data, {'x': 1});
      c.undo();
      expect(c.nodes[a.id]!.data, isEmpty);
      c.redo();
      c.redo();
      expect(c.nodes[a.id]!.data, {'x': 2});
      expect(c.canRedo, isFalse);
    });

    test('a new edit clears redo', () {
      final a = step(Offset.zero);
      c.setData(a.id, {'x': 1});
      c.undo();
      c.setData(a.id, {'x': 9});
      expect(c.canRedo, isFalse);
    });

    test('undo drops a selection that no longer exists', () {
      final a = step(Offset.zero);
      c.undo();
      expect(c.selection, isNot(contains(a.id)));
    });

    test('history is capped', () {
      final capped = CanvasController(portsOf: testPorts, maxUndo: 3);
      for (var i = 0; i < 10; i++) {
        capped.addNode('step', Offset.zero);
      }
      var steps = 0;
      while (capped.canUndo) {
        capped.undo();
        steps++;
      }
      expect(steps, 3);
      capped.dispose();
    });

    test('load replaces everything and forgets history', () {
      step(Offset.zero);
      c.load([
        const CanvasNode(id: 'x', type: 'end', position: Offset.zero),
      ], const []);
      expect(c.nodes.keys, ['x']);
      expect(c.canUndo, isFalse);
    });

    test('revision moves on document changes, not on selection', () {
      final a = step(Offset.zero);
      final r = c.revision;
      c.select(a.id);
      c.clearSelection();
      expect(c.revision, r);
      c.setData(a.id, {'x': 1});
      expect(c.revision, greaterThan(r));
    });
  });

  group('viewport', () {
    test('zooming keeps the point under the pointer in place', () {
      const focal = Offset(300, 200);
      final before = c.viewport.value.toCanvas(focal);
      c.zoomAt(focal, 1.5);
      expect(c.viewport.value.zoom, 1.5);
      final after = c.viewport.value.toCanvas(focal);
      expect((after - before).distance, lessThan(1e-9));
    });

    test('zoom is clamped', () {
      c.zoomAt(Offset.zero, 1000);
      expect(c.viewport.value.zoom, CanvasController.maxZoom);
      c.zoomAt(Offset.zero, 0.0001);
      expect(c.viewport.value.zoom, CanvasController.minZoom);
    });

    test('fit frames every node inside the view', () {
      step(Offset.zero);
      step(const Offset(2000, 1200));
      const size = Size(800, 600);
      c.fit(size);
      final v = c.viewport.value;
      for (final n in c.nodes.values) {
        final r = nodeRect(n, 2);
        final tl = v.toScreen(r.topLeft);
        final br = v.toScreen(r.bottomRight);
        expect(tl.dx, greaterThanOrEqualTo(0));
        expect(tl.dy, greaterThanOrEqualTo(0));
        expect(br.dx, lessThanOrEqualTo(size.width));
        expect(br.dy, lessThanOrEqualTo(size.height));
      }
    });
  });

  group('hit testing', () {
    test('finds the node, port, and edge under a point', () {
      final a = step(Offset.zero);
      final b = step(const Offset(400, 0));
      c.connect(a.id, 'b', b.id);
      expect(c.nodeAt(const Offset(10, 10))?.id, a.id);
      expect(c.nodeAt(const Offset(-50, -50)), isNull);
      final port = c.portAt(outputAnchor(a, 1) + const Offset(2, 1), 8);
      expect(port?.port.id, 'b');
      final anchors = c.edgeAnchors(c.edges.single)!;
      final mid = bezierAt(edgeControls(anchors.$1, anchors.$2), 0.5);
      expect(c.edgeAt(mid + const Offset(0, 3), 6), c.edges.single);
      expect(c.edgeAt(mid + const Offset(0, 80), 6), isNull);
    });
  });
}
