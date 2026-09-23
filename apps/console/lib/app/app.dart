import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'router.dart';

/// Root widget. Theming from the resolved brand arrives in S3-02; until then
/// this is the neutral Material theme with no product label.
class ConsoleApp extends ConsumerWidget {
  const ConsoleApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      title: '',
      theme: ThemeData(colorSchemeSeed: Colors.blueGrey, useMaterial3: true),
      routerConfig: ref.watch(routerProvider),
    );
  }
}
