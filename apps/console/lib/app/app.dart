import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'brand.dart';
import 'router.dart';

/// Root widget. The theme comes from the resolved brand, or neutral.
class ConsoleApp extends ConsumerWidget {
  const ConsoleApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      debugShowCheckedModeBanner: false,
      title: ref.watch(brandProvider).displayName ?? 'Console',
      theme: buildTheme(ref.watch(brandProvider)),
      routerConfig: ref.watch(routerProvider),
    );
  }
}
