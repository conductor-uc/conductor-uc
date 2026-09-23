import 'dart:math' as math;

import 'package:console_api/console_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The resolved brand for this session: a reseller's brand, or neutral
/// (02 §5). Neutral carries no name and no logo.
class Brand {
  const Brand({
    this.displayName,
    this.primary,
    this.accent,
    this.logoLightUrl,
    this.faviconUrl,
    this.supportEmail,
    this.legalFooter,
  });

  const Brand.neutral() : this();

  factory Brand.fromApi(PublicBrand dto) {
    if (dto.neutral) return const Brand.neutral();
    return Brand(
      displayName: _blankToNull(dto.displayName),
      primary: parseHex(dto.primaryColor),
      accent: parseHex(dto.accentColor),
      logoLightUrl: _blankToNull(dto.logoLightUrl),
      faviconUrl: _blankToNull(dto.faviconUrl),
      supportEmail: _blankToNull(dto.supportEmail),
      legalFooter: _blankToNull(dto.legalFooter),
    );
  }

  final String? displayName;
  final Color? primary;
  final Color? accent;
  final String? logoLightUrl;
  final String? faviconUrl;
  final String? supportEmail;
  final String? legalFooter;

  bool get isNeutral =>
      displayName == null &&
      primary == null &&
      accent == null &&
      logoLightUrl == null;
}

String? _blankToNull(String? value) =>
    (value == null || value.trim().isEmpty) ? null : value;

/// `#rrggbb` to a [Color], or null for anything else.
Color? parseHex(String? value) {
  if (value == null || !RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(value)) {
    return null;
  }
  return Color(0xFF000000 | int.parse(value.substring(1), radix: 16));
}

/// WCAG 2.x contrast ratio between two opaque colors.
double contrastRatio(Color a, Color b) {
  final la = a.computeLuminance();
  final lb = b.computeLuminance();
  return (math.max(la, lb) + 0.05) / (math.min(la, lb) + 0.05);
}

const _neutralPrimary = Color(0xFF455A64);
const _neutralAccent = Color(0xFF37474F);

/// Black or white, whichever reads better on [background]. One of the two
/// always reaches WCAG AA (4.5:1) for text on any color; pairs of two brand
/// colors are what the brand editor validates on save (S3-07).
Color _onColor(Color background) =>
    contrastRatio(background, Colors.white) >=
        contrastRatio(background, Colors.black)
    ? Colors.white
    : Colors.black;

/// ThemeData from a brand, or from the neutral grayscale palette (02 §5.3).
ThemeData buildTheme(Brand brand) {
  final primary = brand.primary ?? _neutralPrimary;
  final secondary = brand.accent ?? _neutralAccent;
  final scheme = ColorScheme.fromSeed(seedColor: primary).copyWith(
    primary: primary,
    onPrimary: _onColor(primary),
    secondary: secondary,
    onSecondary: _onColor(secondary),
  );
  return ThemeData(colorScheme: scheme, useMaterial3: true);
}

/// Overridden in `main` with the brand fetched before `runApp` (08 §2).
final brandProvider = Provider<Brand>((ref) => const Brand.neutral());

/// The brand for [host], or neutral when the fetch fails: an unreachable or
/// unknown brand must never block the console from rendering (02 §5.2).
Future<Brand> fetchBrand(ConsoleApi api, String host) async {
  try {
    final response = await api
        .getPublicApi()
        .getPublicBrand(host: host)
        .timeout(const Duration(seconds: 3));
    final data = response.data;
    return data == null ? const Brand.neutral() : Brand.fromApi(data);
  } catch (_) {
    return const Brand.neutral();
  }
}
