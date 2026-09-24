import 'dart:ui';

import 'package:console/canvas/canvas.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

CanvasNode _node(String id, double x, double y, {String type = 'step'}) =>
    CanvasNode(id: id, type: type, position: Offset(x, y));

var _headerBuilds = 0;

Future<CanvasController> _pump(
  WidgetTester tester, {
  List<CanvasNode>? nodes,
  List<CanvasEdge> edges = const [],
  void Function(Object, Offset)? onDrop,
  Widget? above,
}) async {
  tester.view.physicalSize = const Size(1000, 700);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final controller = newController();
  addTearDown(controller.dispose);
  controller.load(nodes ?? [_node('a', 100, 100), _node('b', 500, 100)], edges);
  _headerBuilds = 0;
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Column(
          children: [
            ?above,
            Expanded(
              child: CanvasView(
                controller: controller,
                onDrop: onDrop,
                header: (_, node) {
                  _headerBuilds++;
                  return Center(child: Text(node.id));
                },
              ),
            ),
          ],
        ),
      ),
    ),
  );
  return controller;
}

void main() {
  testWidgets('dragging a node moves it, snapped to the grid', (tester) async {
    final c = await _pump(tester);
    await tester.dragFrom(const Offset(160, 120), const Offset(105, 62));
    await tester.pump();
    expect(c.nodes['a']!.position, const Offset(200, 160));
    expect(c.selection, {'a'});
  });

  testWidgets('dragging a port onto a node connects them', (tester) async {
    final c = await _pump(tester);
    // Output port `b` of node a sits at (320, 183).
    await tester.dragFrom(const Offset(320, 183), const Offset(260, -40));
    await tester.pump();
    expect(c.edges, [const CanvasEdge('a', 'b', 'b')]);
  });

  testWidgets('dropping a dragged port on empty space connects nothing', (
    tester,
  ) async {
    final c = await _pump(tester);
    await tester.dragFrom(const Offset(320, 157), const Offset(100, 300));
    await tester.pump();
    expect(c.edges, isEmpty);
  });

  testWidgets('dragging across empty space selects with a marquee', (
    tester,
  ) async {
    final c = await _pump(tester);
    await tester.dragFrom(const Offset(60, 60), const Offset(300, 200));
    await tester.pump();
    expect(c.selection, {'a'});
    await tester.dragFrom(const Offset(40, 300), const Offset(900, -250));
    await tester.pump();
    expect(c.selection, {'a', 'b'});
  });

  testWidgets('clicking empty space clears the selection', (tester) async {
    final c = await _pump(tester);
    c.selectAll();
    await tester.tapAt(const Offset(50, 500));
    await tester.pump();
    expect(c.selection, isEmpty);
  });

  testWidgets('shift-click adds to and removes from the selection', (
    tester,
  ) async {
    final c = await _pump(tester);
    await tester.tapAt(const Offset(160, 120));
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.tapAt(const Offset(560, 120));
    await tester.pump();
    expect(c.selection, {'a', 'b'});
    await tester.tapAt(const Offset(160, 120));
    await tester.pump();
    expect(c.selection, {'b'});
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
  });

  testWidgets('a selected connection is removed with Delete', (tester) async {
    final c = await _pump(tester, edges: const [CanvasEdge('a', 'a', 'b')]);
    final anchors = c.edgeAnchors(c.edges.single)!;
    final mid = bezierAt(edgeControls(anchors.$1, anchors.$2), 0.5);
    await tester.tapAt(mid);
    await tester.pump();
    expect(c.selectedEdge, c.edges.single);
    await tester.sendKeyEvent(LogicalKeyboardKey.delete);
    await tester.pump();
    expect(c.edges, isEmpty);
    expect(c.nodes, hasLength(2));
  });

  testWidgets('keyboard: delete, undo, redo, copy, paste, select all', (
    tester,
  ) async {
    final c = await _pump(tester);
    await tester.tapAt(const Offset(160, 120));
    await tester.sendKeyEvent(LogicalKeyboardKey.delete);
    expect(c.nodes.keys, ['b']);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyZ);
    expect(c.nodes.keys, containsAll(['a', 'b']));
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyZ);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    expect(c.nodes.keys, ['b']);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyA);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyC);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
    expect(c.nodes, hasLength(2));
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
  });

  testWidgets('scrolling pans, and ctrl-scroll zooms about the pointer', (
    tester,
  ) async {
    final c = await _pump(tester);
    final mouse = TestPointer(1, PointerDeviceKind.mouse);
    await tester.sendEventToBinding(mouse.hover(const Offset(400, 300)));
    await tester.sendEventToBinding(mouse.scroll(const Offset(0, 100)));
    expect(c.viewport.value.pan, const Offset(0, -100));

    final before = c.viewport.value.toCanvas(const Offset(400, 300));
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendEventToBinding(mouse.scroll(const Offset(0, -200)));
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    expect(c.viewport.value.zoom, greaterThan(1));
    final after = c.viewport.value.toCanvas(const Offset(400, 300));
    expect((after - before).distance, lessThan(1e-6));
  });

  testWidgets('space and drag pans without touching nodes', (tester) async {
    final c = await _pump(tester);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.space);
    await tester.dragFrom(const Offset(160, 120), const Offset(50, 30));
    await tester.sendKeyUpEvent(LogicalKeyboardKey.space);
    expect(c.viewport.value.pan, const Offset(50, 30));
    expect(c.nodes['a']!.position, const Offset(100, 100));
  });

  testWidgets('dragging a node moves it correctly when zoomed', (tester) async {
    final c = await _pump(tester);
    c.zoomAt(Offset.zero, 2);
    // Node a's header is now at screen (220, 240) or so.
    await tester.dragFrom(const Offset(240, 250), const Offset(80, 80));
    await tester.pump();
    expect(c.nodes['a']!.position, const Offset(140, 140));
  });

  testWidgets('the zoom buttons zoom and fit', (tester) async {
    final c = await _pump(tester);
    await tester.tap(find.byTooltip('Zoom in'));
    expect(c.viewport.value.zoom, greaterThan(1));
    await tester.tap(find.byTooltip('Fit to view'));
    await tester.pump();
    expect(c.viewport.value.zoom, lessThanOrEqualTo(1));
  });

  testWidgets('something dropped on the canvas reports where', (tester) async {
    Object? dropped;
    Offset? at;
    await _pump(
      tester,
      onDrop: (data, point) {
        dropped = data;
        at = point;
      },
      above: const SizedBox(
        height: 50,
        child: Draggable<Object>(
          data: 'thing',
          feedback: SizedBox(width: 10, height: 10),
          child: SizedBox(width: 100, height: 50, child: Text('drag me')),
        ),
      ),
    );
    final gesture = await tester.startGesture(
      tester.getCenter(find.text('drag me')),
    );
    await gesture.moveTo(const Offset(600, 400));
    await gesture.up();
    await tester.pump();
    expect(dropped, 'thing');
    expect(at, isNotNull);
  });

  testWidgets('150 nodes: panning and zooming do not rebuild them', (
    tester,
  ) async {
    final nodes = [
      for (var i = 0; i < 150; i++)
        _node('n$i', (i % 15) * 260.0, (i ~/ 15) * 200.0),
    ];
    final edges = [
      for (var i = 0; i < 149; i++) CanvasEdge('n$i', 'a', 'n${i + 1}'),
    ];
    final c = await _pump(tester, nodes: nodes, edges: edges);
    final built = _headerBuilds;
    expect(built, greaterThanOrEqualTo(150));

    final mouse = TestPointer(1, PointerDeviceKind.mouse);
    await tester.sendEventToBinding(mouse.hover(const Offset(500, 350)));
    final watch = Stopwatch()..start();
    for (var i = 0; i < 60; i++) {
      await tester.sendEventToBinding(mouse.scroll(const Offset(30, 20)));
      c.zoomAt(const Offset(500, 350), i.isEven ? 1.02 : 0.98);
      await tester.pump(const Duration(milliseconds: 16));
    }
    watch.stop();
    expect(_headerBuilds, built, reason: 'pan and zoom repaint, not rebuild');
    // Debug-mode VM numbers, not a browser profile; only a gross regression
    // would trip this.
    expect(watch.elapsedMilliseconds / 60, lessThan(100));
  });
}
