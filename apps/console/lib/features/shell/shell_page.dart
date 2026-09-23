import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/brand.dart';
import '../../core/acting.dart';
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
    final acting = ref.watch(actingProvider);
    final sections = session == null
        ? const <Section>[]
        : visibleSections(session, acting);
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
          Expanded(
            child: Column(
              children: [
                if (acting != null)
                  _ActingBanner(
                    tenant: acting,
                    onExit: () {
                      ref.read(actingProvider.notifier).exit();
                      final own = sectionsByOrgType[session!.orgType]!.first;
                      context.go(own.path);
                    },
                  ),
                Expanded(child: child),
              ],
            ),
          ),
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

/// Shown on every page while a master or reseller user is inside a tenant.
class _ActingBanner extends StatelessWidget {
  const _ActingBanner({required this.tenant, required this.onExit});

  final ActingTenant tenant;
  final VoidCallback onExit;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.secondaryContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        child: Row(
          children: [
            Icon(Icons.swap_horiz, color: scheme.onSecondaryContainer),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                'Acting as ${tenant.name}',
                style: TextStyle(color: scheme.onSecondaryContainer),
              ),
            ),
            TextButton(onPressed: onExit, child: const Text('Exit')),
          ],
        ),
      ),
    );
  }
}
