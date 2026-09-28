import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/permissions.dart';
import '../../core/session.dart';
import '../../l10n/l10n.dart';
import '../certificates/certificates_api.dart';
import '../orgs/orgs_api.dart';
import '../pbx/pbx_api.dart';
import '../platform/operations_api.dart';
import '../security/security_api.dart';

/// One thing that needs someone: what, and where to deal with it.
class Attention {
  const Attention(this.icon, this.text, this.path, {this.key});

  final IconData icon;
  final String text;
  final String path;
  final String? key;
}

/// A reseller's or the master's home (S9-16): who they are, what needs them,
/// their main action, then the figures ([glance]). Every item comes from a list
/// the console already reads for the screen it leads to; one that cannot be
/// read is left out rather than guessed.
class OrgHome extends ConsumerWidget {
  const OrgHome({super.key, required this.visible, required this.glance});

  /// The sections the person can open: only what they can act on is listed.
  final Set<String> visible;

  final Widget glance;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final session = ref.watch(sessionProvider)!;
    final isMaster = session.orgType == OrgType.master;
    final name = ref.watch(meProvider).value?.orgName;
    final items = isMaster
        ? _masterItems(ref, l10n)
        : _resellerItems(ref, l10n, session.orgId);
    final canCreate = isMaster
        ? ref.watch(canProvider('reseller.create')) &&
              visible.contains('/resellers')
        : ref.watch(canProvider('tenant.create')) &&
              visible.contains('/tenants');

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            name ?? l10n.navDashboard,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 4),
          Text(isMaster ? l10n.ohMasterSubtitle : l10n.ohResellerSubtitle),
          const SizedBox(height: 16),
          if (canCreate)
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: FilledButton.icon(
                key: const ValueKey('org-home-create'),
                icon: const Icon(Icons.add),
                label: Text(isMaster ? l10n.ohNewReseller : l10n.ohNewCustomer),
                // A reseller is still made in a short form; a customer has the
                // setup wizard.
                onPressed: () =>
                    context.go(isMaster ? '/resellers' : '/tenants/new'),
              ),
            ),
          const SizedBox(height: 16),
          Card(
            key: const ValueKey('org-home-attention'),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.notifications_outlined),
                      const SizedBox(width: 8),
                      Text(
                        l10n.homeAttentionTitle,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  if (items.isEmpty)
                    Text(l10n.homeAttentionNone)
                  else
                    for (final item in items)
                      ListTile(
                        key: item.key == null
                            ? null
                            : ValueKey<String>(item.key!),
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(
                          item.icon,
                          color: Theme.of(context).colorScheme.error,
                        ),
                        title: Text(item.text),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => context.go(item.path),
                      ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 24),
          Text(
            l10n.homeGlanceTitle,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          glance,
        ],
      ),
    );
  }

  List<Attention> _resellerItems(
    WidgetRef ref,
    AppLocalizations l10n,
    String resellerId,
  ) {
    final items = <Attention>[];
    if (visible.contains('/tenants')) {
      final tenants = ref.watch(tenantsProvider(resellerId)).value;
      if (tenants != null && tenants.isEmpty) {
        items.add(
          Attention(
            Icons.apartment_outlined,
            l10n.ohNoCustomers,
            '/tenants/new',
            key: 'attention-no-customers',
          ),
        );
      }
      final suspended = [
        for (final t in tenants ?? const <Json>[])
          if (t['status'] != 'active') t,
      ];
      if (suspended.isNotEmpty) {
        items.add(
          Attention(
            Icons.pause_circle_outline,
            l10n.ohSuspendedCustomers(suspended.length),
            '/tenants',
            key: 'attention-suspended',
          ),
        );
      }
    }
    if (visible.contains('/brand') &&
        ref.watch(brandProviderFor(resellerId)).hasValue &&
        ref.watch(brandProviderFor(resellerId)).value == null) {
      items.add(
        Attention(
          Icons.palette_outlined,
          l10n.ohNoBrand,
          '/brand',
          key: 'attention-brand',
        ),
      );
    }
    if (visible.contains('/domains')) {
      final domains = ref.watch(baseDomainsProvider(resellerId)).value;
      final unverified = [
        for (final d in domains ?? const <Json>[])
          if (d['status'] != 'active') d,
      ];
      if (unverified.isNotEmpty) {
        items.add(
          Attention(
            Icons.dns_outlined,
            l10n.ohUnverifiedDomains(unverified.length),
            '/domains',
            key: 'attention-domains',
          ),
        );
      }
    }
    if (visible.contains('/certificates')) {
      final failing = [
        for (final c
            in ref.watch(resellerCertificatesProvider(resellerId)).value ??
                const <Json>[])
          if (c['status'] == 'failed') c,
      ];
      if (failing.isNotEmpty) {
        items.add(
          Attention(
            Icons.gpp_bad_outlined,
            l10n.ohFailingCertificates(failing.length),
            '/certificates',
            key: 'attention-certificates',
          ),
        );
      }
    }
    return items;
  }

  List<Attention> _masterItems(WidgetRef ref, AppLocalizations l10n) {
    final items = <Attention>[];
    if (visible.contains('/operations')) {
      final overview = ref.watch(operationsOverviewProvider).value;
      if (overview != null) {
        final down = overview.services.where((s) => s.status != 'up').length;
        if (down > 0) {
          items.add(
            Attention(
              Icons.monitor_heart_outlined,
              l10n.ohServicesDown(down),
              '/operations',
              key: 'attention-services',
            ),
          );
        }
        final out = overview.nodes.where((n) => !n.inService).length;
        if (out > 0) {
          items.add(
            Attention(
              Icons.dns_outlined,
              l10n.ohNodesOut(out),
              '/operations',
              key: 'attention-nodes',
            ),
          );
        }
      }
    }
    if (visible.contains('/security')) {
      final settings = ref.watch(securitySettingsProvider).value;
      if (settings != null && settings['requireMasterMfa'] != true) {
        items.add(
          Attention(
            Icons.lock_open_outlined,
            l10n.ohMfaOff,
            '/security',
            key: 'attention-mfa',
          ),
        );
      }
    }
    if (visible.contains('/certificates')) {
      final failing = [
        for (final c
            in ref.watch(platformCertificatesProvider).value ?? const <Json>[])
          if (c['status'] == 'failed') c,
      ];
      if (failing.isNotEmpty) {
        items.add(
          Attention(
            Icons.gpp_bad_outlined,
            l10n.ohFailingCertificates(failing.length),
            '/certificates',
            key: 'attention-certificates',
          ),
        );
      }
    }
    if (visible.contains('/resellers')) {
      final resellers = ref.watch(resellersProvider).value;
      if (resellers != null && resellers.isEmpty) {
        items.add(
          Attention(
            Icons.storefront_outlined,
            l10n.ohNoResellers,
            '/resellers',
            key: 'attention-no-resellers',
          ),
        );
      }
      final suspended = [
        for (final r in resellers ?? const <Json>[])
          if (r['status'] != 'active') r,
      ];
      if (suspended.isNotEmpty) {
        items.add(
          Attention(
            Icons.pause_circle_outline,
            l10n.ohSuspendedResellers(suspended.length),
            '/resellers',
            key: 'attention-suspended',
          ),
        );
      }
    }
    return items;
  }
}
