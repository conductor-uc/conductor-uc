// ignore_for_file: avoid_print
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../canvas/canvas.dart';

/// A benchmark for the canvas, not part of the console: 150 connected nodes,
/// panned and zoomed continuously for [seconds], with frame timings printed as
/// one `BENCH {...}` line. Build with
/// `flutter build web --profile -t lib/dev/canvas_bench.dart`.
const seconds = 6;

List<CanvasPort> _ports(CanvasNode node) => const [
  CanvasPort('a', 'next'),
  CanvasPort('b', 'other'),
];

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = CanvasController(portsOf: _ports)
    ..load(
      [
        for (var i = 0; i < 150; i++)
          CanvasNode(
            id: 'n$i',
            type: 'step',
            position: Offset((i % 15) * 300.0, (i ~/ 15) * 220.0),
          ),
      ],
      [
        for (var i = 0; i < 149; i++) CanvasEdge('n$i', 'a', 'n${i + 1}'),
        for (var i = 0; i < 135; i++) CanvasEdge('n$i', 'b', 'n${i + 15}'),
      ],
    );

  final spans = <double>[];
  SchedulerBinding.instance.addTimingsCallback((timings) {
    for (final t in timings) {
      spans.add(t.totalSpan.inMicroseconds / 1000);
    }
  });

  runApp(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        body: CanvasView(
          controller: controller,
          header: (_, node) => Center(child: Text(node.id)),
        ),
      ),
    ),
  );

  final started = DateTime.now();
  var last = Duration.zero;
  late Ticker ticker;
  ticker = Ticker((elapsed) {
    final t = elapsed.inMilliseconds / 1000;
    if (t > seconds) {
      ticker.stop();
      spans.sort();
      double at(double q) => spans[((spans.length - 1) * q).round()];
      final result = {
        'nodes': 150,
        'frames': spans.length,
        'seconds': seconds,
        'avgMs': spans.reduce((a, b) => a + b) / spans.length,
        'p50Ms': at(0.5),
        'p95Ms': at(0.95),
        'maxMs': spans.last,
        'over16_7msPct':
            100 * spans.where((s) => s > 16.7).length / spans.length,
      };
      print('BENCH ${jsonEncode(result)}');
      return;
    }
    final dt = elapsed - last;
    last = elapsed;
    controller.panBy(
      Offset(math.cos(t * 2) * 12, math.sin(t * 3) * 9) *
          (dt.inMicroseconds / 16667),
    );
    controller.zoomAt(
      const Offset(600, 350),
      1 + math.sin(t * 2) * 0.008 * (dt.inMicroseconds / 16667),
    );
  })..start();
  print('started ${started.toIso8601String()}');
}
