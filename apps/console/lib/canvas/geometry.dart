import 'dart:math' as math;
import 'dart:ui';

import 'model.dart';

/// Fixed node geometry, in canvas units. The engine draws the frame and the
/// ports, and the application supplies what goes in the header.
class NodeMetrics {
  const NodeMetrics._();

  static const width = 220.0;
  static const headerHeight = 44.0;
  static const portRowHeight = 26.0;
  static const portRadius = 6.0;

  /// How close, in screen pixels, a pointer must be to grab a port or edge.
  static const hitSlop = 10.0;

  static double heightFor(int ports) =>
      headerHeight + math.max(1, ports) * portRowHeight + 6;

  static Size sizeFor(int ports) => Size(width, heightFor(ports));
}

Rect nodeRect(CanvasNode node, int ports) =>
    node.position & NodeMetrics.sizeFor(ports);

/// Where the connection into [node] ends: the middle of the header, left edge.
Offset inputAnchor(CanvasNode node) =>
    node.position + const Offset(0, NodeMetrics.headerHeight / 2);

/// Where output port number [index] of [node] starts.
Offset outputAnchor(CanvasNode node, int index) =>
    node.position +
    Offset(
      NodeMetrics.width,
      NodeMetrics.headerHeight +
          index * NodeMetrics.portRowHeight +
          NodeMetrics.portRowHeight / 2,
    );

/// The cubic Bézier for a connection from [a] (an output) to [b] (an input).
List<Offset> edgeControls(Offset a, Offset b) {
  final reach = math.max(60.0, (b.dx - a.dx).abs() / 2);
  return [a, a + Offset(reach, 0), b - Offset(reach, 0), b];
}

Offset bezierAt(List<Offset> c, double t) {
  final u = 1 - t;
  return c[0] * (u * u * u) +
      c[1] * (3 * u * u * t) +
      c[2] * (3 * u * t * t) +
      c[3] * (t * t * t);
}

/// The curve as a path, for painting.
Path edgePath(Offset a, Offset b) {
  final c = edgeControls(a, b);
  return Path()
    ..moveTo(c[0].dx, c[0].dy)
    ..cubicTo(c[1].dx, c[1].dy, c[2].dx, c[2].dy, c[3].dx, c[3].dy);
}

/// Distance from [p] to the curve, by sampling it.
double distanceToEdge(Offset p, Offset a, Offset b, {int samples = 24}) {
  final c = edgeControls(a, b);
  var best = double.infinity;
  Offset? previous;
  for (var i = 0; i <= samples; i++) {
    final point = bezierAt(c, i / samples);
    if (previous != null) {
      best = math.min(best, _distanceToSegment(p, previous, point));
    }
    previous = point;
  }
  return best;
}

double _distanceToSegment(Offset p, Offset a, Offset b) {
  final ab = b - a;
  final lengthSquared = ab.dx * ab.dx + ab.dy * ab.dy;
  if (lengthSquared == 0) return (p - a).distance;
  final t = (((p.dx - a.dx) * ab.dx + (p.dy - a.dy) * ab.dy) / lengthSquared)
      .clamp(0.0, 1.0);
  return (p - (a + ab * t)).distance;
}

/// [v] rounded to the nearest multiple of [grid].
double snap(double v, double grid) => (v / grid).round() * grid;
