import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_web_plugins/url_strategy.dart';

import 'app/app.dart';
import 'app/brand.dart';
import 'app/brand_bootstrap.dart';

Future<void> main() async {
  // Path URLs, so deep links and reloads restore the page from the URL (08 §1).
  usePathUrlStrategy();
  WidgetsFlutterBinding.ensureInitialized();
  final brand = await bootstrapBrand();
  runApp(
    ProviderScope(
      overrides: [brandProvider.overrideWithValue(brand)],
      child: const ConsoleApp(),
    ),
  );
}
