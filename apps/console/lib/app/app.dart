import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'brand.dart';
import 'brand_bootstrap.dart';
import 'session_brand.dart';
import 'router.dart';

/// Root widget. The theme comes from the resolved brand, or neutral.
class ConsoleApp extends ConsumerWidget {
  const ConsoleApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // The tab title and icon follow the brand through sign-in and sign-out.
    ref.listen(
      effectiveBrandProvider,
      (_, brand) => applyBrandToDocument(brand),
    );
    return MaterialApp.router(
      debugShowCheckedModeBanner: false,
      title: ref.watch(effectiveBrandProvider).displayName ?? 'Console',
      theme: buildTheme(ref.watch(effectiveBrandProvider)),
      routerConfig: ref.watch(routerProvider),
    );
  }
}
