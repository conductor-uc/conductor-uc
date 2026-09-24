import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import 'brand_page.dart';
import 'domains_panel.dart';
import 'orgs_api.dart';
import 'orgs_page.dart';

/// One reseller, as the master sees it: its details and status, its tenants,
/// its base domains, and its brand.
class ResellerPage extends ConsumerWidget {
  const ResellerPage({super.key, required this.resellerId});

  final String resellerId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final resellers = ref.watch(resellersProvider);
    return AsyncBody<List<Json>>(
      value: resellers,
      emptyText: 'No such reseller.',
      builder: (rows) {
        final match = rows.where((r) => r['id'] == resellerId);
        if (match.isEmpty) {
          return const Center(child: Text('No such reseller.'));
        }
        return _Detail(reseller: match.first);
      },
    );
  }
}

class _Detail extends ConsumerWidget {
  const _Detail({required this.reseller});

  final Json reseller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final suspended = reseller['status'] != 'active';
    final id = '${reseller['id']}';
    return DefaultTabController(
      length: 3,
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            PageHeader(
              title: '${reseller['name']}',
              subtitle:
                  '${reseller['slug']} · ${suspended ? reseller['status'] : 'active'}'
                  '${reseller['timezone'] == null ? '' : ' · ${reseller['timezone']}'}',
              leading: IconButton(
                tooltip: 'Back to resellers',
                icon: const Icon(Icons.arrow_back),
                onPressed: () => context.go('/resellers'),
              ),
              actions: [
                OutlinedButton(
                  onPressed: () =>
                      orgAction(context, ref, reseller, true, 'edit'),
                  child: const Text('Edit'),
                ),
                OutlinedButton(
                  onPressed: () =>
                      orgAction(context, ref, reseller, true, 'suspend'),
                  child: Text(suspended ? 'Resume' : 'Suspend'),
                ),
              ],
            ),
            const SizedBox(height: 8),
            const TabBar(
              isScrollable: true,
              tabAlignment: TabAlignment.start,
              tabs: [
                Tab(text: 'Tenants'),
                Tab(text: 'Domains'),
                Tab(text: 'Brand'),
              ],
            ),
            Expanded(
              child: TabBarView(
                children: [
                  OrgsPage(resellerId: id, embedded: true),
                  Padding(
                    padding: const EdgeInsets.only(top: 16),
                    child: Column(children: [BaseDomainsPanel(resellerId: id)]),
                  ),
                  BrandPage(resellerId: id),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
