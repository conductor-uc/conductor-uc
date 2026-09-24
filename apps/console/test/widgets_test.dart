import 'package:console/app/brand.dart';
import 'package:console/widgets/page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

Widget _host(Widget child, Brand brand) => MaterialApp(
  theme: buildTheme(brand),
  home: Scaffold(body: child),
);

void main() {
  // The widget library takes everything from the theme, so each piece has to
  // work the same under the neutral palette and under a brand.
  for (final (name, brand) in [
    ('neutral', const Brand.neutral()),
    ('a brand', sampleBrand),
  ]) {
    group('under $name', () {
      testWidgets('PageHeader shows title, subtitle, leading, and actions', (
        tester,
      ) async {
        await tester.pumpWidget(
          _host(
            PageHeader(
              title: 'Things',
              subtitle: 'What they are.',
              leading: const Icon(Icons.arrow_back),
              actions: [
                FilledButton(onPressed: () {}, child: const Text('New')),
                TextButton(onPressed: () {}, child: const Text('Other')),
              ],
            ),
            brand,
          ),
        );
        expect(find.text('Things'), findsOneWidget);
        expect(find.text('What they are.'), findsOneWidget);
        expect(find.byIcon(Icons.arrow_back), findsOneWidget);
        expect(find.text('New'), findsOneWidget);
        expect(find.text('Other'), findsOneWidget);
      });

      testWidgets('ErrorText uses the theme error color', (tester) async {
        await tester.pumpWidget(_host(const ErrorText('Nope'), brand));
        final text = tester.widget<Text>(find.text('Nope'));
        expect(text.style?.color, buildTheme(brand).colorScheme.error);
      });

      testWidgets('AsyncBody shows loading, error, empty, then data', (
        tester,
      ) async {
        Widget body(AsyncValue<List<String>> v) => _host(
          AsyncBody<List<String>>(
            value: v,
            emptyText: 'Nothing yet.',
            builder: (rows) => Text(rows.join(',')),
          ),
          brand,
        );
        await tester.pumpWidget(body(const AsyncLoading()));
        expect(find.byType(CircularProgressIndicator), findsOneWidget);
        await tester.pumpWidget(body(AsyncError('x', StackTrace.empty)));
        expect(find.text('Something went wrong.'), findsOneWidget);
        await tester.pumpWidget(body(const AsyncData([])));
        expect(find.text('Nothing yet.'), findsOneWidget);
        await tester.pumpWidget(body(const AsyncData(['a', 'b'])));
        expect(find.text('a,b'), findsOneWidget);
      });
    });
  }
}
