import 'package:console/app/brand.dart';
import 'package:console/core/theme_mode.dart';
import 'package:console/dev/demo_backend.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

void main() {
  testWidgets('login, neutral', (tester) async {
    await pumpApp(tester, appWith());
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/login_neutral.png'),
    );
  });

  testWidgets('login, sample reseller brand', (tester) async {
    await pumpApp(tester, appWith(brand: sampleBrand));
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/login_brand.png'),
    );
  });

  testWidgets('theme of a brand differs from neutral', (tester) async {
    expect(
      buildTheme(sampleBrand).colorScheme.primary,
      isNot(buildTheme(const Brand.neutral()).colorScheme.primary),
    );
  });

  // The signed-in console, once the session's own brand is known (S3-02).
  testWidgets('signed in as the master: neutral, no label and no logo', (
    tester,
  ) async {
    await completeSignIn(tester, 'master@example.test');
    expect(find.byType(Image), findsNothing);
    expect(find.text('Sample Reseller'), findsNothing);
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/shell_neutral.png'),
    );
  });

  testWidgets('signed in as a reseller: re-themed from the session', (
    tester,
  ) async {
    await completeSignIn(tester, 'reseller@example.test');
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/shell_brand.png'),
    );
  });

  // S9-17: dark mode, with the brand's colors where they read on dark.
  testWidgets('signed in as a reseller, dark: the brand kept where it reads', (
    tester,
  ) async {
    await pumpApp(
      tester,
      appWith(
        api: demoApi(),
        overrides: [themeModeProvider.overrideWith(() => _DarkMode())],
      ),
    );
    await submitSignIn(tester, 'reseller@example.test');
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/shell_brand_dark.png'),
    );
  });

  test('dark mode keeps a brand color only where it stands out', () {
    final dark = buildTheme(sampleBrand, brightness: Brightness.dark);
    expect(dark.brightness, Brightness.dark);
    // The sample's deep purple would vanish on a dark surface: a lighter
    // shade of the same hue is used.
    expect(dark.colorScheme.primary, isNot(sampleBrand.primary));
    expect(
      contrastRatio(dark.colorScheme.primary, dark.colorScheme.surface),
      greaterThanOrEqualTo(3),
    );
    // Its light yellow accent stands out already, and is kept.
    expect(dark.colorScheme.secondary, sampleBrand.accent);
  });
}

class _DarkMode extends ThemeModeController {
  @override
  ThemeMode build() => ThemeMode.dark;
}
