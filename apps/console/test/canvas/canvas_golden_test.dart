import 'package:console/canvas/canvas.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

void main() {
  testWidgets('canvas with nodes, connections, and a selection', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(900, 500);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final c = newController();
    addTearDown(c.dispose);
    c.load(
      [
        const CanvasNode(id: 'a', type: 'step', position: Offset(40, 60)),
        const CanvasNode(id: 'b', type: 'step', position: Offset(360, 40)),
        const CanvasNode(id: 'c', type: 'end', position: Offset(360, 240)),
        const CanvasNode(id: 'd', type: 'step', position: Offset(660, 140)),
      ],
      const [
        CanvasEdge('a', 'a', 'b'),
        CanvasEdge('a', 'b', 'c'),
        CanvasEdge('b', 'a', 'd'),
      ],
    );
    c.select('b');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CanvasView(
            controller: c,
            header: (_, node) => Center(child: Text(node.id)),
          ),
        ),
      ),
    );
    await expectLater(
      find.byType(CanvasView),
      matchesGoldenFile('../goldens/canvas.png'),
    );
  });
}
