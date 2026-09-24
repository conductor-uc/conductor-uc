import 'dart:ui';

import 'package:flutter/material.dart';

import 'controller.dart';
import 'geometry.dart';
import 'model.dart';

/// What the pointer is doing right now, drawn above the nodes.
class CanvasOverlay {
  const CanvasOverlay({this.marquee, this.connectFrom, this.connectTo});

  /// The selection rectangle, in canvas units.
  final Rect? marquee;

  /// The connection being dragged, from an output anchor to the pointer.
  final Offset? connectFrom;
  final Offset? connectTo;
}

/// Grid and connections, under the nodes.
class GridAndEdgesPainter extends CustomPainter {
  GridAndEdgesPainter({required this.controller, required this.colors})
    : super(repaint: Listenable.merge([controller, controller.viewport]));

  final CanvasController controller;
  final ColorScheme colors;

  @override
  void paint(Canvas canvas, Size size) {
    final v = controller.viewport.value;
    canvas
      ..save()
      ..translate(v.pan.dx, v.pan.dy)
      ..scale(v.zoom);
    _grid(canvas, size, v);
    _edges(canvas, v);
    canvas.restore();
  }

  void _grid(Canvas canvas, Size size, CanvasViewport v) {
    // Every cell when it is big enough to see, every fifth when it is not.
    var step = controller.gridSize;
    if (step * v.zoom < 8) step *= 5;
    final top = v.toCanvas(Offset.zero);
    final bottom = v.toCanvas(size.bottomRight(Offset.zero));
    final paint = Paint()
      ..color = colors.outlineVariant.withValues(alpha: 0.6)
      ..strokeWidth = 1 / v.zoom;
    final points = <Offset>[];
    for (var x = (top.dx / step).floor() * step; x <= bottom.dx; x += step) {
      for (var y = (top.dy / step).floor() * step; y <= bottom.dy; y += step) {
        points.add(Offset(x, y));
      }
    }
    canvas.drawPoints(PointMode.points, points, paint);
  }

  void _edges(Canvas canvas, CanvasViewport v) {
    for (final edge in controller.edges) {
      final anchors = controller.edgeAnchors(edge);
      if (anchors == null) continue;
      final selected = edge == controller.selectedEdge;
      canvas.drawPath(
        edgePath(anchors.$1, anchors.$2),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = (selected ? 3 : 2) / v.zoom.clamp(0.5, 2)
          ..color = selected ? colors.primary : colors.outline,
      );
    }
  }

  @override
  bool shouldRepaint(GridAndEdgesPainter old) =>
      old.controller != controller || old.colors != colors;
}

/// The marquee and the connection being dragged, above the nodes.
class OverlayPainter extends CustomPainter {
  OverlayPainter({
    required this.controller,
    required this.overlay,
    required this.colors,
  }) : super(repaint: Listenable.merge([overlay, controller.viewport]));

  final CanvasController controller;
  final ValueNotifier<CanvasOverlay?> overlay;
  final ColorScheme colors;

  @override
  void paint(Canvas canvas, Size size) {
    final state = overlay.value;
    if (state == null) return;
    final v = controller.viewport.value;
    canvas
      ..save()
      ..translate(v.pan.dx, v.pan.dy)
      ..scale(v.zoom);
    final marquee = state.marquee;
    if (marquee != null) {
      canvas
        ..drawRect(
          marquee,
          Paint()..color = colors.primary.withValues(alpha: 0.12),
        )
        ..drawRect(
          marquee,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1 / v.zoom
            ..color = colors.primary,
        );
    }
    final from = state.connectFrom;
    final to = state.connectTo;
    if (from != null && to != null) {
      canvas.drawPath(
        edgePath(from, to),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2 / v.zoom.clamp(0.5, 2)
          ..color = colors.primary,
      );
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(OverlayPainter old) => old.colors != colors;
}

/// One node: the application's header, then a labeled row per output port,
/// with the port dots on the frame. The frame is exactly the size
/// [NodeMetrics] says, which is what lets connections and hit tests be
/// computed without asking widgets where they are.
class NodeFrame extends StatelessWidget {
  const NodeFrame({
    super.key,
    required this.node,
    required this.ports,
    required this.selected,
    required this.header,
  });

  final CanvasNode node;
  final List<CanvasPort> ports;
  final bool selected;
  final Widget header;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    const r = NodeMetrics.portRadius;
    Widget dot(Color color) => Container(
      width: r * 2,
      height: r * 2,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
        border: Border.all(color: scheme.surface, width: 2),
      ),
    );
    return SizedBox(
      width: NodeMetrics.width,
      height: NodeMetrics.heightFor(ports.length),
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: scheme.surface,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: selected ? scheme.primary : scheme.outlineVariant,
                  width: selected ? 2 : 1,
                ),
                boxShadow: const [
                  BoxShadow(blurRadius: 3, color: Color(0x22000000)),
                ],
              ),
              child: Column(
                children: [
                  SizedBox(height: NodeMetrics.headerHeight, child: header),
                  for (final p in ports)
                    SizedBox(
                      height: NodeMetrics.portRowHeight,
                      child: Padding(
                        padding: const EdgeInsets.only(right: 14),
                        child: Align(
                          alignment: Alignment.centerRight,
                          child: Text(
                            p.label,
                            style: theme.textTheme.labelSmall,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          Positioned(
            left: -r,
            top: NodeMetrics.headerHeight / 2 - r,
            child: dot(scheme.secondary),
          ),
          for (var i = 0; i < ports.length; i++)
            Positioned(
              right: -r,
              top:
                  NodeMetrics.headerHeight +
                  i * NodeMetrics.portRowHeight +
                  NodeMetrics.portRowHeight / 2 -
                  r,
              child: dot(scheme.primary),
            ),
        ],
      ),
    );
  }
}
