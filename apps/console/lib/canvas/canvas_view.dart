import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'controller.dart';
import 'geometry.dart';
import 'model.dart';
import 'painters.dart';

typedef NodeHeaderBuilder = Widget Function(
  BuildContext context,
  CanvasNode node,
);

enum _Drag { none, move, connect, marquee, pan }

/// Pan and zoom canvas for a [CanvasController].
///
/// - Drag a node to move it; drag a port to a node to connect; drag empty
///   space to select a rectangle; shift adds to the selection.
/// - Scroll or two-finger drag pans; ctrl or cmd with scroll, or a pinch,
///   zooms. Middle button or space with drag also pans.
/// - Delete, ctrl+Z, ctrl+shift+Z or ctrl+Y, ctrl+C, ctrl+V, ctrl+A.
///
/// Every pointer interaction is resolved by geometry, so node widgets are for
/// looking at; they take no input themselves.
class CanvasView extends StatefulWidget {
  const CanvasView({
    super.key,
    required this.controller,
    required this.header,
    this.onDrop,
  });

  final CanvasController controller;

  /// What each node shows in its header.
  final NodeHeaderBuilder header;

  /// Called with the data of a `Draggable` dropped on the canvas, and where
  /// (canvas units).
  final void Function(Object data, Offset canvasPoint)? onDrop;

  @override
  State<CanvasView> createState() => _CanvasViewState();
}

class _CanvasViewState extends State<CanvasView> {
  final _focus = FocusNode();
  final _overlay = ValueNotifier<CanvasOverlay?>(null);
  var _drag = _Drag.none;
  var _additive = false;
  Offset _startScreen = Offset.zero;
  Offset _lastScreen = Offset.zero;
  Offset _startCanvas = Offset.zero;
  ({CanvasNode node, CanvasPort port})? _from;
  var _lastScale = 1.0;

  CanvasController get _c => widget.controller;

  @override
  void dispose() {
    _focus.dispose();
    _overlay.dispose();
    super.dispose();
  }

  bool get _shift => HardwareKeyboard.instance.isShiftPressed;
  bool get _command =>
      HardwareKeyboard.instance.isControlPressed ||
      HardwareKeyboard.instance.isMetaPressed;

  void _down(PointerDownEvent e) {
    _focus.requestFocus();
    final local = e.localPosition;
    _startScreen = _lastScreen = local;
    final v = _c.viewport.value;
    final at = v.toCanvas(local);
    _startCanvas = at;
    _additive = _shift;

    final panning =
        e.buttons == kMiddleMouseButton ||
        HardwareKeyboard.instance.isLogicalKeyPressed(LogicalKeyboardKey.space);
    if (panning) {
      _drag = _Drag.pan;
      return;
    }
    if (e.buttons != kPrimaryButton) return;

    final slop = NodeMetrics.hitSlop / v.zoom;
    final port = _c.portAt(at, slop);
    if (port != null) {
      _drag = _Drag.connect;
      _from = port;
      _overlay.value = CanvasOverlay(
        connectFrom: outputAnchor(
          port.node,
          _c.portsOf(port.node).indexWhere((p) => p.id == port.port.id),
        ),
        connectTo: at,
      );
      return;
    }
    final node = _c.nodeAt(at);
    if (node != null) {
      if (_additive) {
        _c.select(node.id, additive: true);
        if (!_c.selection.contains(node.id)) return;
      } else if (!_c.selection.contains(node.id)) {
        _c.select(node.id);
      }
      _drag = _Drag.move;
      _c.beginMove();
      return;
    }
    final edge = _c.edgeAt(at, slop);
    if (edge != null) {
      _c.selectEdge(edge);
      return;
    }
    if (!_additive) _c.clearSelection();
    _drag = _Drag.marquee;
  }

  void _move(PointerMoveEvent e) {
    final local = e.localPosition;
    final v = _c.viewport.value;
    final at = v.toCanvas(local);
    switch (_drag) {
      case _Drag.none:
        break;
      case _Drag.pan:
        _c.panBy(local - _lastScreen);
      case _Drag.move:
        _c.moveBy((local - _startScreen) / v.zoom);
      case _Drag.connect:
        _overlay.value = CanvasOverlay(
          connectFrom: _overlay.value?.connectFrom,
          connectTo: at,
        );
      case _Drag.marquee:
        _overlay.value = CanvasOverlay(
          marquee: Rect.fromPoints(_startCanvas, at),
        );
    }
    _lastScreen = local;
  }

  void _up(PointerEvent e, {required bool cancelled}) {
    final at = _c.viewport.value.toCanvas(e.localPosition);
    switch (_drag) {
      case _Drag.connect:
        final from = _from;
        final target = _c.nodeAt(at);
        if (!cancelled && from != null && target != null) {
          _c.connect(from.node.id, from.port.id, target.id);
        }
      case _Drag.move:
        _c.endMove();
      case _Drag.marquee:
        final area = Rect.fromPoints(_startCanvas, at);
        if (!cancelled && area.longestSide * _c.viewport.value.zoom > 3) {
          _c.marquee(area, additive: _additive);
        }
      case _Drag.none || _Drag.pan:
        break;
    }
    _drag = _Drag.none;
    _from = null;
    _overlay.value = null;
  }

  void _signal(PointerSignalEvent e) {
    if (e is! PointerScrollEvent) return;
    if (_command) {
      _c.zoomAt(e.localPosition, math.exp(-e.scrollDelta.dy / 400));
    } else {
      _c.panBy(-e.scrollDelta);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return LayoutBuilder(
      builder: (context, constraints) {
        _c.viewSize = constraints.biggest;
        final surface = Listener(
          behavior: HitTestBehavior.opaque,
          onPointerDown: _down,
          onPointerMove: _move,
          onPointerUp: (e) => _up(e, cancelled: false),
          onPointerCancel: (e) => _up(e, cancelled: true),
          onPointerSignal: _signal,
          onPointerPanZoomStart: (_) => _lastScale = 1,
          onPointerPanZoomUpdate: (e) {
            _c.panBy(e.panDelta);
            if (e.scale != _lastScale) {
              _c.zoomAt(e.localPosition, e.scale / _lastScale);
              _lastScale = e.scale;
            }
          },
          child: ClipRect(
            child: Stack(
              fit: StackFit.expand,
              children: [
                ColoredBox(color: scheme.surfaceContainerLowest),
                CustomPaint(
                  painter: GridAndEdgesPainter(controller: _c, colors: scheme),
                ),
                IgnorePointer(child: _nodes()),
                CustomPaint(
                  painter: OverlayPainter(
                    controller: _c,
                    overlay: _overlay,
                    colors: scheme,
                  ),
                ),
              ],
            ),
          ),
        );
        final onDrop = widget.onDrop;
        final Widget canvas = onDrop == null
            ? surface
            : DragTarget<Object>(
                onAcceptWithDetails: (d) {
                  final box = context.findRenderObject() as RenderBox;
                  final local = box.globalToLocal(d.offset);
                  onDrop(d.data, _c.viewport.value.toCanvas(local));
                },
                builder: (_, _, _) => surface,
              );
        return Stack(
          children: [
            Positioned.fill(
              child: CallbackShortcuts(
                bindings: _bindings(),
                child: Focus(focusNode: _focus, child: canvas),
              ),
            ),
            Positioned(right: 12, bottom: 12, child: _zoomControls()),
          ],
        );
      },
    );
  }

  /// The node widgets, moved and scaled by the viewport without rebuilding.
  Widget _nodes() => ValueListenableBuilder<CanvasViewport>(
    valueListenable: _c.viewport,
    builder: (context, v, child) => Transform(
      transform: Matrix4.identity()
        ..translateByDouble(v.pan.dx, v.pan.dy, 0, 1)
        ..scaleByDouble(v.zoom, v.zoom, 1, 1),
      alignment: Alignment.topLeft,
      child: child,
    ),
    child: ListenableBuilder(
      listenable: _c,
      builder: (context, _) => SizedBox.shrink(
        child: OverflowBox(
          alignment: Alignment.topLeft,
          minWidth: 0,
          minHeight: 0,
          maxWidth: 100000,
          maxHeight: 100000,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              for (final node in _c.nodes.values)
                Positioned(
                  left: node.position.dx,
                  top: node.position.dy,
                  child: RepaintBoundary(
                    child: NodeFrame(
                      node: node,
                      ports: _c.portsOf(node),
                      selected: _c.selection.contains(node.id),
                      header: widget.header(context, node),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    ),
  );

  Map<ShortcutActivator, VoidCallback> _bindings() {
    final map = <ShortcutActivator, VoidCallback>{
      const SingleActivator(LogicalKeyboardKey.delete): _c.deleteSelection,
      const SingleActivator(LogicalKeyboardKey.backspace): _c.deleteSelection,
      const SingleActivator(LogicalKeyboardKey.escape): _c.clearSelection,
    };
    for (final (control, meta) in [(true, false), (false, true)]) {
      SingleActivator key(LogicalKeyboardKey k, {bool shift = false}) =>
          SingleActivator(k, control: control, meta: meta, shift: shift);
      map[key(LogicalKeyboardKey.keyZ)] = _c.undo;
      map[key(LogicalKeyboardKey.keyZ, shift: true)] = _c.redo;
      map[key(LogicalKeyboardKey.keyY)] = _c.redo;
      map[key(LogicalKeyboardKey.keyC)] = _c.copy;
      map[key(LogicalKeyboardKey.keyV)] = _c.paste;
      map[key(LogicalKeyboardKey.keyA)] = _c.selectAll;
    }
    return map;
  }

  Widget _zoomControls() {
    Widget button(IconData icon, String tip, VoidCallback onTap) => IconButton(
      icon: Icon(icon),
      tooltip: tip,
      onPressed: onTap,
      visualDensity: VisualDensity.compact,
    );
    final center = Offset(_c.viewSize.width / 2, _c.viewSize.height / 2);
    return Material(
      elevation: 2,
      borderRadius: BorderRadius.circular(8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          button(Icons.add, 'Zoom in', () => _c.zoomAt(center, 1.25)),
          button(Icons.remove, 'Zoom out', () => _c.zoomAt(center, 0.8)),
          button(Icons.fit_screen_outlined, 'Fit to view', _c.fitToView),
        ],
      ),
    );
  }
}
