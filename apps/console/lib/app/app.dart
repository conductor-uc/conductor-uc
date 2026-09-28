import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../l10n/l10n.dart';

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
    final brandName = ref.watch(effectiveBrandProvider).displayName;
    return MaterialApp.router(
      debugShowCheckedModeBanner: false,
      onGenerateTitle: (context) => brandName ?? context.l10n.appTitleFallback,
      theme: buildTheme(ref.watch(effectiveBrandProvider)),
      routerConfig: ref.watch(routerProvider),
      // S9-01 (D-018): every string comes from lib/l10n; English until
      // translations arrive.
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      builder: (context, child) {
        setCurrentLocale(Localizations.localeOf(context));
        return child!;
      },
    );
  }
}
