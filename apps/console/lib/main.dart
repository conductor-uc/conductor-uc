import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_web_plugins/url_strategy.dart';

import 'app/app.dart';
import 'app/brand.dart';
import 'app/brand_bootstrap.dart';
import 'core/session.dart';

Future<void> main() async {
  // Path URLs, so deep links and reloads restore the page from the URL (08 §1).
  usePathUrlStrategy();
  WidgetsFlutterBinding.ensureInitialized();
  final brand = await bootstrapBrand();
  final container = ProviderContainer(
    overrides: [brandProvider.overrideWithValue(brand)],
  );
  // A reload keeps a signed-in user signed in: the refresh cookie, if there is
  // a good one, is exchanged for a fresh session before the first frame.
  await container.read(sessionProvider.notifier).restore();
  runApp(
    UncontrolledProviderScope(container: container, child: const ConsoleApp()),
  );
}
