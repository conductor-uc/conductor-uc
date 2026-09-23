import 'package:console_api/console_api.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The console talks only to api-gateway (08 §1), which serves the console
/// from the same origin, so requests are relative to it.
final apiProvider = Provider<ConsoleApi>((ref) {
  return ConsoleApi(basePathOverride: '');
});
