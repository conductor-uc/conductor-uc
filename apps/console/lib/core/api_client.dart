import 'package:console_api/console_api.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../dev/demo_backend.dart';
import 'config.dart';

/// The one place the client is built. The console talks only to api-gateway
/// (08 §1); demo mode swaps in canned responses for development.
ConsoleApi createApi() =>
    demoMode ? demoApi() : ConsoleApi(basePathOverride: apiBaseUrl);

final apiProvider = Provider<ConsoleApi>((ref) => createApi());
