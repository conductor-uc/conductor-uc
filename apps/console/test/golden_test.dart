import 'package:console/app/brand.dart';
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
}
