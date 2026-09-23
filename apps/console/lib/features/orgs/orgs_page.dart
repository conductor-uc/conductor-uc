import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/acting.dart';
import '../../core/session.dart';
import '../pbx/pbx_api.dart';
import 'orgs_api.dart';

/// Read-only browsing of the org tree, with "Act as" on each tenant. Creating
/// and editing resellers, tenants, domains, and brands is S3-06 and S3-07.
///
/// - Master at `/resellers`: the resellers; open one for its tenants.
/// - Master at `/resellers/:id`, or a reseller at `/tenants`: tenants.
class OrgsPage extends ConsumerWidget {
  const OrgsPage({super.key, this.resellerId});

  /// The reseller whose tenants to list. Null lists the master's resellers.
  final String? resellerId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider)!;
    final isMaster = session.orgType == OrgType.master;
    final showingResellers = isMaster && resellerId == null;
    final rows = showingResellers
        ? ref.watch(resellersProvider)
        : ref.watch(tenantsProvider(resellerId ?? session.orgId));
    final textTheme = Theme.of(context).textTheme;

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (isMaster && !showingResellers)
                IconButton(
                  tooltip: 'Back to resellers',
                  icon: const Icon(Icons.arrow_back),
                  onPressed: () => context.go('/resellers'),
                ),
              Expanded(
                child: Text(
                  showingResellers ? 'Resellers' : 'Tenants',
                  style: textTheme.headlineSmall,
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Expanded(
            child: rows.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => Center(child: Text(problemMessage(e))),
              data: (data) => data.isEmpty
                  ? Center(
                      child: Text(
                        showingResellers
                            ? 'No resellers yet.'
                            : 'No tenants yet.',
                      ),
                    )
                  : Material(
                      type: MaterialType.transparency,
                      child: ListView(
                        children: [
                          for (final org in data)
                            _OrgTile(org: org, isReseller: showingResellers),
                        ],
                      ),
                    ),
            ),
          ),
        ],
      ),
    );
  }
}

class _OrgTile extends ConsumerWidget {
  const _OrgTile({required this.org, required this.isReseller});

  final Json org;
  final bool isReseller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final suspended = org['status'] != 'active';
    return ListTile(
      leading: Icon(
        isReseller ? Icons.storefront_outlined : Icons.apartment_outlined,
      ),
      title: Text('${org['name']}'),
      subtitle: Text(
        suspended ? '${org['slug']} · ${org['status']}' : '${org['slug']}',
      ),
      trailing: isReseller
          ? const Icon(Icons.chevron_right)
          : FilledButton.tonal(
              onPressed: suspended
                  ? null
                  : () {
                      ref
                          .read(actingProvider.notifier)
                          .enter(
                            ActingTenant(
                              id: '${org['id']}',
                              name: '${org['name']}',
                            ),
                          );
                      context.go('/extensions');
                    },
              child: const Text('Act as'),
            ),
      onTap: isReseller ? () => context.go('/resellers/${org['id']}') : null,
    );
  }
}
