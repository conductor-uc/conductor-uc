import 'package:console/canvas/canvas.dart';

/// A test node vocabulary: `step` has two output ports, `end` has none.
List<CanvasPort> testPorts(CanvasNode node) => switch (node.type) {
  'step' => const [CanvasPort('a', 'A'), CanvasPort('b', 'B')],
  _ => const [],
};

CanvasController newController() => CanvasController(portsOf: testPorts);
