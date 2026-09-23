import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/home/home_page.dart';

/// Each top-level section becomes its own route tree (08 §1); sections are
/// added by their owning tasks (S3-04 onward).
final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    routes: [
      GoRoute(path: '/', builder: (context, state) => const HomePage()),
    ],
  );
});
