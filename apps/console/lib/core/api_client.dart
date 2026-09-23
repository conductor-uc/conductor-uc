import 'package:console_api/console_api.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'config.dart';

/// The console talks only to api-gateway (08 §1).
final apiProvider = Provider<ConsoleApi>((ref) {
  return ConsoleApi(basePathOverride: apiBaseUrl);
});
