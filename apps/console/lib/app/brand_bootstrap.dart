import 'package:console_api/console_api.dart';

import '../core/config.dart';
import 'brand.dart';
import 'document.dart';

/// Runs before `runApp` (08 §2): resolves the brand for this hostname and
/// applies the document title and favicon. Neutral leaves the functional
/// title from `web/index.html` and the neutral favicon in place.
Future<Brand> bootstrapBrand() async {
  final api = ConsoleApi(basePathOverride: apiBaseUrl);
  final brand = await fetchBrand(api, currentHost());
  applyBrandToDocument(brand);
  return brand;
}

void applyBrandToDocument(Brand brand) {
  setDocumentTitle(brand.displayName ?? 'Console');
  final favicon = brand.faviconUrl;
  if (favicon != null) setDocumentFavicon(favicon);
}
