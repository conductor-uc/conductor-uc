import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/session.dart';
import '../features/auth/login_page.dart';
import '../features/shell/sections.dart';
import '../features/shell/shell_page.dart';

/// Each top-level section is its own route (08 §1), so deep links work and a
/// reload restores the page from the URL. Sections are shown by org type.
final routerProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<int>(0);
  ref.listen(sessionProvider, (_, _) => refresh.value++);
  ref.onDispose(refresh.dispose);

  final everySection = {
    for (final list in sectionsByOrgType.values)
      for (final s in list) s.path: s,
  }.values;

  return GoRouter(
    refreshListenable: refresh,
    redirect: (context, state) {
      final session = ref.read(sessionProvider);
      final atLogin = state.uri.path == '/login';
      if (session == null) return atLogin ? null : '/login';
      final sections = sectionsByOrgType[session.orgType]!;
      final path = state.uri.path;
      if (atLogin || path == '/') return sections.first.path;
      // A section the org type does not have is not reachable by URL either.
      if (!sections.any((s) => path.startsWith(s.path))) {
        return sections.first.path;
      }
      return null;
    },
    routes: [
      GoRoute(path: '/login', builder: (context, state) => const LoginPage()),
      ShellRoute(
        builder: (context, state, child) => ShellPage(child: child),
        routes: [
          for (final s in everySection)
            GoRoute(
              path: s.path,
              builder: (context, state) => SectionPage(section: s),
            ),
        ],
      ),
    ],
  );
});
