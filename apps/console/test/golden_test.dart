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
}
