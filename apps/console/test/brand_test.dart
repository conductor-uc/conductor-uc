import 'package:console/app/brand.dart';
import 'package:console_api/console_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

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
            'primaryColor': '#6a1b9a',
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
}

Matcher ge(num n) => greaterThanOrEqualTo(n);
