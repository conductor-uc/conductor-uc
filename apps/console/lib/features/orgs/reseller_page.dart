import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/permissions.dart';
import '../../l10n/l10n.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import '../trunks/trunks_page.dart';
import '../users/users_api.dart';
import '../users/users_page.dart';
import '../certificates/certificates_page.dart';
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
      emptyText: context.l10n.orgNoSuchReseller,
      builder: (rows) {
        final match = rows.where((r) => r['id'] == resellerId);
        if (match.isEmpty) {
          return Center(child: Text(context.l10n.orgNoSuchReseller));
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
    final deleting = reseller['status'] == 'pending_deletion';
    final id = '${reseller['id']}';
    return DefaultTabController(
      length: 6,
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            PageHeader(
              title: '${reseller['name']}',
              subtitle:
                  '${reseller['slug']}'
                  '${suspended ? ' · ${orgStatusText(context.l10n, reseller)}' : ''}'
                  '${reseller['timezone'] == null ? '' : ' · ${reseller['timezone']}'}',
              leading: IconButton(
                tooltip: context.l10n.orgBackToResellers,
                icon: const Icon(Icons.arrow_back),
                onPressed: () => context.go('/resellers'),
              ),
              actions: [
                if (ref.watch(canProvider('reseller.manage'))) ...[
                  OutlinedButton(
                    onPressed: () =>
                        orgAction(context, ref, reseller, true, 'edit'),
                    child: Text(context.l10n.commonEdit),
                  ),
                  if (!deleting)
                    OutlinedButton(
                      onPressed: () =>
                          orgAction(context, ref, reseller, true, 'suspend'),
                      child: Text(
                        suspended
                            ? context.l10n.orgResume
                            : context.l10n.orgSuspend,
                      ),
                    ),
                  // S1-16: only once it has no tenants; the service says so otherwise.
                  OutlinedButton(
                    key: const ValueKey('reseller-delete'),
                    onPressed: () => orgAction(
                      context,
                      ref,
                      reseller,
                      true,
                      deleting ? 'cancel-deletion' : 'delete',
                    ),
                    child: Text(
                      deleting
                          ? context.l10n.orgCancelDeletion
                          : context.l10n.orgDelete,
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 8),
            TabBar(
              isScrollable: true,
              tabAlignment: TabAlignment.start,
              tabs: [
                Tab(text: context.l10n.navTenants),
                Tab(text: context.l10n.navPeople),
                Tab(text: context.l10n.navTrunks),
                Tab(text: context.l10n.navDomains),
                Tab(text: context.l10n.navCertificates),
                Tab(text: context.l10n.navBrand),
              ],
            ),
            Expanded(
              child: TabBarView(
                children: [
                  OrgsPage(resellerId: id, embedded: true),
                  UsersPage(
                    org: UsersTarget.reseller(id),
                    orgName: '${reseller['name']}',
                    embedded: true,
                  ),
                  TrunksPage(resellerId: id),
                  Padding(
                    padding: const EdgeInsets.only(top: 16),
                    child: Column(children: [BaseDomainsPanel(resellerId: id)]),
                  ),
                  CertificatesPanel(resellerId: id),
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
