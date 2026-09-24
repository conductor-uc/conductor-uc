import 'dart:ui';

/// A node on the canvas. `type` and `data` mean nothing to the engine: the
/// application decides what a node is, what it shows, and which output ports
/// it has (see [PortsOf]).
class CanvasNode {
  const CanvasNode({
    required this.id,
    required this.type,
    required this.position,
    this.data = const {},
  });

  final String id;
  final String type;

  /// Top-left corner, in canvas units.
  final Offset position;
  final Map<String, Object?> data;

  CanvasNode copyWith({Offset? position, Map<String, Object?>? data}) =>
      CanvasNode(
        id: id,
        type: type,
        position: position ?? this.position,
        data: data ?? this.data,
      );
}

/// An output port: the point a connection leaves a node from.
class CanvasPort {
  const CanvasPort(this.id, this.label);

  final String id;
  final String label;
}

/// A connection from one node's output [port] to another node's single input.
class CanvasEdge {
  const CanvasEdge(this.from, this.port, this.to);

  final String from;
  final String port;
  final String to;

  @override
  bool operator ==(Object other) =>
      other is CanvasEdge &&
      other.from == from &&
      other.port == port &&
      other.to == to;

  @override
  int get hashCode => Object.hash(from, port, to);
}

/// The output ports of a node. Called often, so keep it cheap.
typedef PortsOf = List<CanvasPort> Function(CanvasNode node);

/// The visible part of the canvas: `screen = canvas * zoom + pan`.
class CanvasViewport {
  const CanvasViewport({this.pan = Offset.zero, this.zoom = 1});

  final Offset pan;
  final double zoom;

  Offset toCanvas(Offset screen) => (screen - pan) / zoom;
  Offset toScreen(Offset canvas) => canvas * zoom + pan;
}

/// The document as it was at one point, for undo.
class CanvasSnapshot {
  const CanvasSnapshot(this.nodes, this.edges);

  final Map<String, CanvasNode> nodes;
  final List<CanvasEdge> edges;
}
