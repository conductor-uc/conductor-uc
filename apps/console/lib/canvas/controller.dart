import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter/foundation.dart';

import 'geometry.dart';
import 'model.dart';

/// The state of one canvas and every operation on it: nodes, connections,
/// selection, the viewport, clipboard, and an undo and redo stack.
///
/// Generic on purpose. It knows nothing about what a node means, only where
/// its ports are (through [portsOf]). Listeners hear about document,
/// selection, and clipboard changes; the viewport has its own notifier so a
/// pan or zoom repaints without rebuilding every node.
class CanvasController extends ChangeNotifier {
  CanvasController({
    required this.portsOf,
    this.gridSize = 20,
    this.singleEdgePerPort = true,
    this.maxUndo = 100,
    this.idFactory,
  });

  final PortsOf portsOf;
  final double gridSize;

  /// Connecting a port that already has a connection replaces it.
  final bool singleEdgePerPort;
  final int maxUndo;

  /// Names a new node; the default is `type-1`, `type-2`, and so on.
  final String Function(String type)? idFactory;

  final viewport = ValueNotifier(const CanvasViewport());

  /// The size of the view showing this canvas, kept by the view.
  Size viewSize = Size.zero;

  Map<String, CanvasNode> _nodes = {};
  List<CanvasEdge> _edges = [];
  final _selection = <String>{};
  CanvasEdge? _selectedEdge;
  final _undo = <CanvasSnapshot>[];
  final _redo = <CanvasSnapshot>[];
  CanvasSnapshot? _clipboard;
  var _pasteCount = 0;
  var _idCounter = 0;
  var _revision = 0;

  // A move in progress: where the moved nodes started.
  CanvasSnapshot? _moveStart;
  Map<String, Offset> _moveOrigins = const {};

  Map<String, CanvasNode> get nodes => Map.unmodifiable(_nodes);
  List<CanvasEdge> get edges => List.unmodifiable(_edges);
  Set<String> get selection => Set.unmodifiable(_selection);
  CanvasEdge? get selectedEdge => _selectedEdge;

  /// Counts document changes (not selection or viewport), so an autosave can
  /// tell whether there is anything new to save.
  int get revision => _revision;
  bool get canUndo => _undo.isNotEmpty;
  bool get canRedo => _redo.isNotEmpty;
  bool get canPaste => _clipboard != null;

  CanvasSnapshot snapshot() => CanvasSnapshot(Map.of(_nodes), List.of(_edges));

  /// Replaces the whole document and forgets undo history.
  void load(Iterable<CanvasNode> nodes, Iterable<CanvasEdge> edges) {
    _nodes = {for (final n in nodes) n.id: n};
    _edges = [...edges];
    _selection.clear();
    _selectedEdge = null;
    _undo.clear();
    _redo.clear();
    _revision++;
    notifyListeners();
  }

  // ---- history --------------------------------------------------------

  void _record([CanvasSnapshot? before]) {
    _undo.add(before ?? snapshot());
    if (_undo.length > maxUndo) _undo.removeAt(0);
    _redo.clear();
  }

  void _restore(CanvasSnapshot s) {
    _nodes = Map.of(s.nodes);
    _edges = List.of(s.edges);
    _selection.removeWhere((id) => !_nodes.containsKey(id));
    if (_selectedEdge != null && !_edges.contains(_selectedEdge)) {
      _selectedEdge = null;
    }
    _revision++;
    notifyListeners();
  }

  void undo() {
    if (_undo.isEmpty) return;
    _redo.add(snapshot());
    _restore(_undo.removeLast());
  }

  void redo() {
    if (_redo.isEmpty) return;
    _undo.add(snapshot());
    _restore(_redo.removeLast());
  }

  void _changed() {
    _revision++;
    notifyListeners();
  }

  // ---- nodes ----------------------------------------------------------

  String freshId(String type) {
    final make = idFactory;
    if (make != null) return make(type);
    String id;
    do {
      id = '$type-${++_idCounter}';
    } while (_nodes.containsKey(id));
    return id;
  }

  /// Adds a node, snapped to the grid, and selects it. Returns it.
  CanvasNode addNode(
    String type,
    Offset at, {
    Map<String, Object?> data = const {},
    String? id,
  }) {
    _record();
    final node = CanvasNode(
      id: id ?? freshId(type),
      type: type,
      position: _snapOffset(at),
      data: data,
    );
    _nodes[node.id] = node;
    _selection
      ..clear()
      ..add(node.id);
    _selectedEdge = null;
    _changed();
    return node;
  }

  /// Replaces one node's data (a properties edit). One undo step.
  void setData(String id, Map<String, Object?> data) {
    final node = _nodes[id];
    if (node == null) return;
    _record();
    _nodes[id] = node.copyWith(data: data);
    _changed();
  }

  Offset _snapOffset(Offset p) =>
      Offset(snap(p.dx, gridSize), snap(p.dy, gridSize));

  /// Starts moving the selected nodes; follow with [moveBy] and [endMove].
  void beginMove() {
    _moveStart = snapshot();
    _moveOrigins = {for (final id in _selection) id: _nodes[id]!.position};
  }

  /// Places the moved nodes at their start plus [delta] (the total drag so
  /// far, in canvas units), snapped to the grid.
  void moveBy(Offset delta) {
    if (_moveStart == null) return;
    _moveOrigins.forEach((id, origin) {
      final node = _nodes[id];
      if (node != null) {
        _nodes[id] = node.copyWith(position: _snapOffset(origin + delta));
      }
    });
    _revision++;
    notifyListeners();
  }

  void endMove() {
    final start = _moveStart;
    _moveStart = null;
    if (start == null) return;
    final moved = _moveOrigins.keys.any(
      (id) => _nodes[id]?.position != start.nodes[id]?.position,
    );
    if (moved) _record(start);
    _moveOrigins = const {};
    notifyListeners();
  }

  // ---- edges ----------------------------------------------------------

  /// Connects [from]'s output [port] to [to]. False when it makes no sense:
  /// an unknown node or port, a loop onto itself, or a connection that is
  /// already there.
  bool connect(String from, String port, String to) {
    final source = _nodes[from];
    if (source == null || !_nodes.containsKey(to) || from == to) return false;
    if (!portsOf(source).any((p) => p.id == port)) return false;
    final edge = CanvasEdge(from, port, to);
    if (_edges.contains(edge)) return false;
    _record();
    if (singleEdgePerPort) {
      _edges.removeWhere((e) => e.from == from && e.port == port);
    }
    _edges.add(edge);
    _selectedEdge = edge;
    _selection.clear();
    _changed();
    return true;
  }

  void removeEdge(CanvasEdge edge) {
    if (!_edges.contains(edge)) return;
    _record();
    _edges.remove(edge);
    if (_selectedEdge == edge) _selectedEdge = null;
    _changed();
  }

  // ---- selection ------------------------------------------------------

  void select(String id, {bool additive = false}) {
    if (!_nodes.containsKey(id)) return;
    _selectedEdge = null;
    if (additive) {
      if (!_selection.remove(id)) _selection.add(id);
    } else {
      _selection
        ..clear()
        ..add(id);
    }
    notifyListeners();
  }

  void selectEdge(CanvasEdge edge) {
    _selection.clear();
    _selectedEdge = edge;
    notifyListeners();
  }

  void clearSelection() {
    if (_selection.isEmpty && _selectedEdge == null) return;
    _selection.clear();
    _selectedEdge = null;
    notifyListeners();
  }

  void selectAll() {
    _selectedEdge = null;
    _selection
      ..clear()
      ..addAll(_nodes.keys);
    notifyListeners();
  }

  /// Selects the nodes whose frames touch [area] (canvas units).
  void marquee(Rect area, {bool additive = false}) {
    if (!additive) _selection.clear();
    _selectedEdge = null;
    for (final node in _nodes.values) {
      if (area.overlaps(nodeRect(node, portsOf(node).length))) {
        _selection.add(node.id);
      }
    }
    notifyListeners();
  }

  /// Removes the selected nodes and the connections to them, or the selected
  /// connection.
  void deleteSelection() {
    final edge = _selectedEdge;
    if (edge != null) {
      removeEdge(edge);
      return;
    }
    if (_selection.isEmpty) return;
    _record();
    _nodes.removeWhere((id, _) => _selection.contains(id));
    _edges.removeWhere(
      (e) => _selection.contains(e.from) || _selection.contains(e.to),
    );
    _selection.clear();
    _changed();
  }

  // ---- clipboard ------------------------------------------------------

  /// Copies the selected nodes and the connections between them.
  void copy() {
    if (_selection.isEmpty) return;
    _clipboard = CanvasSnapshot(
      {for (final id in _selection) id: _nodes[id]!},
      [
        for (final e in _edges)
          if (_selection.contains(e.from) && _selection.contains(e.to)) e,
      ],
    );
    _pasteCount = 0;
    notifyListeners();
  }

  /// Pastes the copied nodes with new ids, a little down and to the right of
  /// where they were, and selects them. One undo step.
  void paste() {
    final clip = _clipboard;
    if (clip == null || clip.nodes.isEmpty) return;
    _record();
    _pasteCount++;
    final shift = Offset(gridSize * 2, gridSize * 2) * _pasteCount.toDouble();
    final renamed = <String, String>{};
    for (final node in clip.nodes.values) {
      final id = freshId(node.type);
      renamed[node.id] = id;
      _nodes[id] = CanvasNode(
        id: id,
        type: node.type,
        position: _snapOffset(node.position + shift),
        data: Map.of(node.data),
      );
    }
    for (final e in clip.edges) {
      _edges.add(CanvasEdge(renamed[e.from]!, e.port, renamed[e.to]!));
    }
    _selectedEdge = null;
    _selection
      ..clear()
      ..addAll(renamed.values);
    _changed();
  }

  // ---- hit testing ----------------------------------------------------

  /// The topmost node under [p] (canvas units).
  CanvasNode? nodeAt(Offset p) {
    CanvasNode? hit;
    for (final node in _nodes.values) {
      if (nodeRect(node, portsOf(node).length).contains(p)) hit = node;
    }
    return hit;
  }

  /// The output port under [p], within [slop] canvas units.
  ({CanvasNode node, CanvasPort port})? portAt(Offset p, double slop) {
    for (final node in _nodes.values) {
      final ports = portsOf(node);
      for (var i = 0; i < ports.length; i++) {
        if ((outputAnchor(node, i) - p).distance <= slop) {
          return (node: node, port: ports[i]);
        }
      }
    }
    return null;
  }

  /// The connection nearest [p] within [slop] canvas units.
  CanvasEdge? edgeAt(Offset p, double slop) {
    CanvasEdge? best;
    var bestDistance = slop;
    for (final edge in _edges) {
      final anchors = edgeAnchors(edge);
      if (anchors == null) continue;
      final d = distanceToEdge(p, anchors.$1, anchors.$2);
      if (d <= bestDistance) {
        best = edge;
        bestDistance = d;
      }
    }
    return best;
  }

  /// Where [edge] starts and ends, or null when a node it names is gone.
  (Offset, Offset)? edgeAnchors(CanvasEdge edge) {
    final from = _nodes[edge.from];
    final to = _nodes[edge.to];
    if (from == null || to == null) return null;
    final index = portsOf(from).indexWhere((p) => p.id == edge.port);
    if (index < 0) return null;
    return (outputAnchor(from, index), inputAnchor(to));
  }

  // ---- viewport -------------------------------------------------------

  static const minZoom = 0.2;
  static const maxZoom = 2.5;

  void panBy(Offset delta) {
    final v = viewport.value;
    viewport.value = CanvasViewport(pan: v.pan + delta, zoom: v.zoom);
  }

  /// Zooms by [factor] keeping the canvas point under [focal] (screen
  /// coordinates) where it is.
  void zoomAt(Offset focal, double factor) {
    final v = viewport.value;
    final zoom = (v.zoom * factor).clamp(minZoom, maxZoom);
    final under = v.toCanvas(focal);
    viewport.value = CanvasViewport(pan: focal - under * zoom, zoom: zoom);
  }

  void fitToView() => fit(viewSize);

  /// Frames every node in a view of [size].
  void fit(Size size, {double padding = 48}) {
    Rect? bounds;
    for (final node in _nodes.values) {
      final r = nodeRect(node, portsOf(node).length);
      bounds = bounds == null ? r : bounds.expandToInclude(r);
    }
    if (bounds == null || size.isEmpty) {
      viewport.value = const CanvasViewport();
      return;
    }
    final zoom = math
        .min(
          (size.width - padding * 2) / bounds.width,
          (size.height - padding * 2) / bounds.height,
        )
        .clamp(minZoom, 1.0);
    viewport.value = CanvasViewport(
      pan: size.center(Offset.zero) - bounds.center * zoom,
      zoom: zoom,
    );
  }

  @override
  void dispose() {
    viewport.dispose();
    super.dispose();
  }
}
