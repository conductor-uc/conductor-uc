import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/acting.dart';
import '../../core/session.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource_form.dart';
import 'org_defs.dart';
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
              FilledButton.icon(
                onPressed: () => _create(
                  context,
                  ref,
                  showingResellers ? null : resellerId ?? session.orgId,
                ),
                icon: const Icon(Icons.add),
                label: Text(showingResellers ? 'New reseller' : 'New tenant'),
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

  /// Creates a reseller (`parentReseller` null) or a tenant under one.
  Future<void> _create(
    BuildContext context,
    WidgetRef ref,
    String? parentReseller,
  ) async {
    final api = ref.read(orgsApiProvider);
    if (api == null) return;
    final created = await showDialog<Json>(
      context: context,
      builder: (_) => ResourceFormDialog(
        def: parentReseller == null ? resellerDef : tenantDef,
        save: (_, body) => api.create(resellerId: parentReseller, body: body),
      ),
    );
    if (created == null) return;
    ref.invalidate(resellersProvider);
    if (parentReseller != null) ref.invalidate(tenantsProvider(parentReseller));
    final admin = (created['adminUser'] as Map?)?['email'];
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Created ${created['name']}.'
            '${admin == null ? '' : ' Its administrator signs in as $admin.'}',
          ),
        ),
      );
    }
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
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (!isReseller)
            FilledButton.tonal(
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
          PopupMenuButton<String>(
            tooltip: 'More',
            onSelected: (choice) => _menu(context, ref, choice),
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'edit', child: Text('Edit')),
              PopupMenuItem(
                value: 'suspend',
                child: Text(suspended ? 'Resume' : 'Suspend'),
              ),
            ],
          ),
          if (isReseller) const Icon(Icons.chevron_right),
        ],
      ),
      onTap: isReseller ? () => context.go('/resellers/${org['id']}') : null,
    );
  }
}

extension on _OrgTile {
  Future<void> _menu(BuildContext context, WidgetRef ref, String choice) async {
    final api = ref.read(orgsApiProvider);
    if (api == null) return;
    final id = '${org['id']}';
    void refresh() {
      ref.invalidate(resellersProvider);
      ref.invalidate(tenantsProvider);
    }

    if (choice == 'edit') {
      final saved = await showDialog<Json>(
        context: context,
        builder: (_) => ResourceFormDialog(
          def: isReseller ? resellerDef : tenantDef,
          row: org,
          save: (_, body) =>
              api.update(reseller: isReseller, id: id, body: body),
        ),
      );
      if (saved != null) refresh();
      return;
    }

    final suspend = org['status'] == 'active';
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('${suspend ? 'Suspend' : 'Resume'} ${org['name']}?'),
        content: Text(
          suspend
              ? 'Their users are signed out and calls stop routing until it is resumed.'
              : 'Service is restored.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(suspend ? 'Suspend' : 'Resume'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await api.setSuspended(reseller: isReseller, id: id, suspended: suspend);
      refresh();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(problemMessage(e))));
    }
  }
}
