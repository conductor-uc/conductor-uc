import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/session.dart';
import '../features/orgs/orgs_api.dart';
import 'brand.dart';

/// The brand of the signed-in user's own org, or null while signed out or
/// while it loads. The hostname can only say which reseller's console this is;
/// a tenant or reseller who signs in at a shared address is re-themed from
/// this (S3-02). A failed lookup falls back to the hostname brand: a brand
/// must never block the console (02 §5.2).
final sessionBrandProvider = FutureProvider<Brand?>((ref) async {
  final api = ref.watch(orgsApiProvider);
  if (api == null) return null;
  try {
    return Brand.fromJson(await api.sessionBrand());
  } catch (_) {
    return null;
  }
});

/// What the console is themed with right now: the session's brand once it is
/// known, else the hostname's.
final effectiveBrandProvider = Provider<Brand>((ref) {
  final session = ref.watch(sessionProvider);
  final own = session == null ? null : ref.watch(sessionBrandProvider).value;
  return own ?? ref.watch(brandProvider);
});
