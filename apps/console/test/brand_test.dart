import 'package:console/app/brand.dart';

import 'dart:typed_data';

import 'package:console_api/console_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:console/dev/demo_backend.dart';

import 'support.dart';

void main() {
  group('Brand.fromApi', () {
    test('neutral response is neutral', () {
      expect(Brand.fromApi(PublicBrand(neutral: true)).isNeutral, isTrue);
    });

    test('maps a reseller brand and drops blank strings', () {
      final brand = Brand.fromApi(
        PublicBrand(
          neutral: false,
          displayName: 'Acme',
          primaryColor: '#112233',
          legalFooter: ' ',
        ),
      );
      expect(brand.displayName, 'Acme');
      expect(brand.primary, const Color(0xFF112233));
      expect(brand.legalFooter, isNull);
    });
  });

  group('buildTheme', () {
    test('uses a brand color that passes AA', () {
      final theme = buildTheme(sampleBrand);
      expect(theme.colorScheme.primary, sampleBrand.primary);
      expect(
        contrastRatio(theme.colorScheme.primary, theme.colorScheme.onPrimary),
        ge(4.5),
      );
    });

    test('picks a readable foreground for light and dark brand colors', () {
      for (final color in const [
        Color(0xFF777777),
        Color(0xFFFFEB3B),
        Color(0xFF1A237E),
      ]) {
        final scheme = buildTheme(Brand(primary: color)).colorScheme;
        expect(
          contrastRatio(scheme.primary, scheme.onPrimary),
          ge(4.5),
          reason: '$color',
        );
      }
    });

    test('neutral palette itself passes AA', () {
      final scheme = buildTheme(const Brand.neutral()).colorScheme;
      expect(contrastRatio(scheme.primary, scheme.onPrimary), ge(4.5));
      expect(contrastRatio(scheme.secondary, scheme.onSecondary), ge(4.5));
    });
  });

  group('fetchBrand', () {
    test('returns the reseller brand', () async {
      final dio = Dio()
        ..httpClientAdapter = FakeAdapter((options) {
          expect(options.queryParameters['host'], 'portal.example');
          return jsonBody({
            'neutral': false,
            'displayName': 'Acme',
            'primaryColor': '#4a148c',
          });
        });
      final brand = await fetchBrand(ConsoleApi(dio: dio), 'portal.example');
      expect(brand.displayName, 'Acme');
    });

    test('falls back to neutral when the request fails', () async {
      final dio = Dio()
        ..httpClientAdapter = FakeAdapter((_) => jsonBody({}, status: 500));
      final brand = await fetchBrand(ConsoleApi(dio: dio), 'portal.example');
      expect(brand.isNeutral, isTrue);
    });
  });

  group('re-theme after login', () {
    ThemeData themeOf(WidgetTester tester) =>
        Theme.of(tester.element(find.byType(Scaffold).first));

    testWidgets(
      'a reseller signing in on a neutral host takes its brand, and gives it back on sign out',
      (tester) async {
        await completeSignIn(tester, 'reseller@example.test');
        expect(themeOf(tester).colorScheme.primary, sampleBrand.primary);
        expect(find.text('Sample Reseller'), findsWidgets);

        await tester.tap(find.widgetWithText(TextButton, 'Sign out'));
        await tester.pumpAndSettle();
        expect(themeOf(tester).colorScheme.primary, isNot(sampleBrand.primary));
        expect(find.text('Sample Reseller'), findsNothing);
      },
    );

    testWidgets('the master stays neutral', (tester) async {
      await completeSignIn(tester, 'master@example.test');
      expect(themeOf(tester).colorScheme.primary, isNot(sampleBrand.primary));
      expect(find.text('Sample Reseller'), findsNothing);
    });

    testWidgets('a failed lookup keeps the hostname brand', (tester) async {
      final demo = demoApi();
      final dio = demo.dio;
      dio.httpClientAdapter = _Split(
        dio.httpClientAdapter,
        FakeAdapter((_) => jsonBody({}, status: 500)),
      );
      await pumpApp(tester, appWith(api: demo, brand: sampleBrand));
      await submitSignIn(tester, 'tenant@example.test');
      expect(themeOf(tester).colorScheme.primary, sampleBrand.primary);
    });
  });
}

/// Sends the session-brand call to [failing] and everything else to [real].
class _Split implements HttpClientAdapter {
  _Split(this.real, this.failing);

  final HttpClientAdapter real;
  final HttpClientAdapter failing;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) => (options.path == '/v1/session/brand' ? failing : real).fetch(
    options,
    requestStream,
    cancelFuture,
  );

  @override
  void close({bool force = false}) {}
}

Matcher ge(num n) => greaterThanOrEqualTo(n);
