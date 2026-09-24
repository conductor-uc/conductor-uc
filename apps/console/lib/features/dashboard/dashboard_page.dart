import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/acting.dart';
import '../../core/permissions.dart';
import '../../core/session.dart';
import '../../widgets/page.dart';
import '../orgs/orgs_api.dart';
import '../pbx/pbx_api.dart';
import '../platform/platform_health_page.dart';
import '../shell/sections.dart';
import '../users/users_api.dart';

/// One figure on the dashboard, and where it leads.
class _Tile {
  const _Tile(this.label, this.icon, this.path, this.count, [this.detail]);

  final String label;
  final IconData icon;
  final String path;

  /// How many there are; loading, failed, or a number.
  final AsyncValue<int> count;

  /// A second line, from the same rows, when there is a useful one.
  final String Function()? detail;
}

int _count(AsyncValue<List<Json>> rows, [bool Function(Json row)? where]) =>
    rows.requireValue.where(where ?? (_) => true).length;

AsyncValue<int> _counted(
  AsyncValue<List<Json>> rows, [
  bool Function(Json row)? where,
]) => rows.whenData((r) => r.where(where ?? (_) => true).length);

/// What is set up, at a glance: counts from the same lists the screens show,
/// for the sections this user can open. Nothing here is a made-up figure; a
/// count that cannot be loaded shows a dash.
class DashboardPage extends ConsumerWidget {
  const DashboardPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    if (session == null) return const SizedBox.shrink();
    final acting = ref.watch(actingProvider);
    final visible = {
      for (final s in visibleSections(
        session,
        acting,
        ref.watch(knownPermissionsProvider),
      ))
        s.path,
    };
    final tiles = <_Tile>[];

    // A tenant user, or a master or reseller inside a tenant: the tenant's setup.
    if (session.orgType == OrgType.tenant || acting != null) {
      AsyncValue<List<Json>> rows(String key) => ref.watch(rowsProvider(key));
      void add(String path, String label, IconData icon, String key) {
        if (!visible.contains(path)) return;
        tiles.add(_Tile(label, icon, path, _counted(rows(key))));
      }

      add('/extensions', 'Extensions', Icons.dialpad_outlined, 'extensions');
      add('/phone-numbers', 'Phone numbers', Icons.phone_outlined, 'dids');
      if (visible.contains('/call-flows')) {
        final flows = rows('flows');
        tiles.add(
          _Tile(
            'Call flows',
            Icons.account_tree_outlined,
            '/call-flows',
            _counted(flows),
            () =>
                '${_count(flows, (f) => f['currentPublishedVersionId'] != null)} published',
          ),
        );
      }
      add('/ring-groups', 'Ring groups', Icons.groups_outlined, 'ring-groups');
      add('/queues', 'Queues', Icons.queue_outlined, 'queues');
      add(
        '/conference-rooms',
        'Conference rooms',
        Icons.video_call_outlined,
        'conference-rooms',
      );
      add(
        '/parking-lots',
        'Parking lots',
        Icons.local_parking_outlined,
        'parking-lots',
      );
      add('/schedules', 'Schedules', Icons.schedule_outlined, 'schedules');
      add('/media', 'Media', Icons.library_music_outlined, 'media-assets');
      if (visible.contains('/users')) {
        tiles.add(
          _Tile(
            'Users',
            Icons.people_outline,
            '/users',
            _counted(ref.watch(usersProvider)),
          ),
        );
      }
    } else if (session.orgType == OrgType.reseller) {
      if (visible.contains('/tenants')) {
        final tenants = ref.watch(tenantsProvider(session.orgId));
        tiles.add(
          _Tile(
            'Tenants',
            Icons.apartment_outlined,
            '/tenants',
            _counted(tenants),
            () =>
                '${_count(tenants, (t) => t['status'] != 'active')} suspended',
          ),
        );
      }
      if (visible.contains('/users')) {
        tiles.add(
          _Tile(
            'Users',
            Icons.people_outline,
            '/users',
            _counted(ref.watch(usersProvider)),
          ),
        );
      }
    } else {
      if (visible.contains('/resellers')) {
        final resellers = ref.watch(resellersProvider);
        tiles.add(
          _Tile(
            'Resellers',
            Icons.storefront_outlined,
            '/resellers',
            _counted(resellers),
            () =>
                '${_count(resellers, (r) => r['status'] != 'active')} suspended',
          ),
        );
      }
      if (visible.contains('/platform-health')) {
        final health = ref.watch(platformHealthProvider);
        tiles.add(
          _Tile(
            'Services ready',
            Icons.monitor_heart_outlined,
            '/platform-health',
            health.whenData((h) => h.ready),
            () => 'of ${health.requireValue.services.length}',
          ),
        );
      }
    }

    return PageFrame(
      children: [
        PageHeader(
          title: 'Dashboard',
          subtitle: acting == null
              ? null
              : "What is set up for ${acting.name}.",
        ),
        const SizedBox(height: 16),
        if (tiles.isEmpty)
          const Text('Nothing to show here for your role yet.')
        else
          Wrap(
            spacing: 16,
            runSpacing: 16,
            children: [for (final t in tiles) _TileCard(tile: t)],
          ),
      ],
    );
  }
}

class _TileCard extends StatelessWidget {
  const _TileCard({required this.tile});

  final _Tile tile;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final count = tile.count;
    final figure = count.when(
      loading: () => '…',
      error: (_, _) => '—',
      data: (n) => '$n',
    );
    final detail = count.hasValue ? tile.detail?.call() : null;
    return SizedBox(
      width: 220,
      child: Card(
        margin: EdgeInsets.zero,
        child: InkWell(
          key: ValueKey('tile-${tile.path}'),
          borderRadius: BorderRadius.circular(12),
          onTap: () => context.go(tile.path),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(tile.icon, size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        tile.label,
                        style: theme.textTheme.titleSmall,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(figure, style: theme.textTheme.headlineMedium),
                Text(detail ?? '', style: theme.textTheme.bodySmall),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
