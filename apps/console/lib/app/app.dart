import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/theme_mode.dart';
import '../core/locale.dart';
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
      // S9-17: dark mode, as the device is set unless the person chose.
      darkTheme: buildTheme(
        ref.watch(effectiveBrandProvider),
        brightness: Brightness.dark,
      ),
      themeMode: ref.watch(themeModeProvider),
      routerConfig: ref.watch(routerProvider),
      // S9-01 (D-018): every string comes from lib/l10n; English until
      // translations arrive.
      locale: ref.watch(localeProvider),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      builder: (context, child) {
        setCurrentLocale(Localizations.localeOf(context));
        // S9-17: a reading direction forced for a preview or a test, until a
        // right-to-left language brings its own.
        final forced = ref.watch(forcedTextDirectionProvider);
        return forced == null
            ? child!
            : Directionality(textDirection: forced, child: child!);
      },
    );
  }
}

/// A reading direction to use whatever the language says (S9-17): for tests
/// and previews of right-to-left layout. Null follows the language.
final forcedTextDirectionProvider = Provider<TextDirection?>((ref) => null);
