import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/brand.dart';
import '../../core/session.dart';
import '../../widgets/brand_header.dart';
import 'sections.dart';

/// The signed-in frame: header, role-based navigation, and the section body
/// (08 §3). Act-as-descendant is S3-05.
class ShellPage extends ConsumerWidget {
  const ShellPage({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final brand = ref.watch(brandProvider);
    final sections = sectionsByOrgType[session?.orgType ?? OrgType.tenant]!;
    final location = GoRouterState.of(context).uri.path;
    final selected = sections.indexWhere((s) => location.startsWith(s.path));

    return Scaffold(
      appBar: AppBar(
        title: BrandHeader(brand: brand),
        actions: [
          TextButton(
            onPressed: () => ref.read(sessionProvider.notifier).signOut(),
            child: const Text('Sign out'),
          ),
        ],
      ),
      body: Row(
        children: [
          NavigationRail(
            extended: MediaQuery.sizeOf(context).width >= 900,
            selectedIndex: selected < 0 ? null : selected,
            onDestinationSelected: (i) => context.go(sections[i].path),
            destinations: [
              for (final s in sections)
                NavigationRailDestination(
                  icon: Icon(s.icon),
                  label: Text(s.label),
                ),
            ],
          ),
          const VerticalDivider(width: 1),
          Expanded(child: child),
        ],
      ),
    );
  }
}

class SectionPage extends StatelessWidget {
  const SectionPage({super.key, required this.section});

  final Section section;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Align(
        alignment: Alignment.topLeft,
        child: Text(
          section.label,
          style: Theme.of(context).textTheme.headlineSmall,
        ),
      ),
    );
  }
}
