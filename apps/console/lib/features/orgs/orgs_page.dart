import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/acting.dart';
import '../../core/permissions.dart';
import '../../core/session.dart';
import '../../l10n/l10n.dart';
import '../../widgets/feedback.dart';
import '../../widgets/page.dart';
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
  const OrgsPage({super.key, this.resellerId, this.embedded = false});

  /// The reseller whose tenants to list. Null lists the master's resellers.
  final String? resellerId;

  /// Inside a reseller's page, which already has the title and the way back.
  final bool embedded;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    // Signing out clears the session a frame before the router leaves this page.
    if (session == null) return const SizedBox.shrink();
    final isMaster = session.orgType == OrgType.master;
    final showingResellers = isMaster && resellerId == null;
    final rows = showingResellers
        ? ref.watch(resellersProvider)
        : ref.watch(tenantsProvider(resellerId ?? session.orgId));
    final l10n = context.l10n;
    return PageFrame(
      children: [
        PageHeader(
          title: showingResellers ? l10n.navResellers : l10n.navTenants,
          leading: isMaster && !showingResellers && !embedded
              ? IconButton(
                  tooltip: l10n.orgBackToResellers,
                  icon: const Icon(Icons.arrow_back),
                  onPressed: () => context.go('/resellers'),
                )
              : null,
          actions: [
            if (ref.watch(
              canProvider(
                showingResellers ? 'reseller.create' : 'tenant.create',
              ),
            ))
              FilledButton.icon(
                // S9-16: a new customer has the setup wizard.
                onPressed: showingResellers
                    ? () => _create(context, ref, null)
                    : () => context.go(
                        isMaster
                            ? '/resellers/$resellerId/new-tenant'
                            : '/tenants/new',
                      ),
                icon: const Icon(Icons.add),
                label: Text(
                  showingResellers ? l10n.orgNewReseller : l10n.orgNewTenant,
                ),
              ),
          ],
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody(
            value: rows,
            emptyText: showingResellers
                ? l10n.orgNoResellers
                : l10n.orgNoTenants,
            builder: (data) => Material(
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
            admin == null
                ? context.l10n.orgCreated('${created['name']}')
                : context.l10n.orgCreatedWithAdmin(
                    '${created['name']}',
                    '$admin',
                  ),
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
    final deleting = org['status'] == 'pending_deletion';
    final canEdit = ref.watch(
      canProvider(isReseller ? 'reseller.manage' : 'tenant.manage'),
    );
    final canSuspend = ref.watch(
      canProvider(isReseller ? 'reseller.manage' : 'tenant.suspend'),
    );
    // A tenant's own name under a reseller base domain (S1-03).
    final domain = isReseller
        ? null
        : ref.watch(tenantDomainProvider('${org['id']}')).value?['fqdn'];
    return ListTile(
      leading: Icon(
        isReseller ? Icons.storefront_outlined : Icons.apartment_outlined,
      ),
      title: Text('${org['name']}'),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            suspended
                ? '${org['slug']} · ${orgStatusText(context.l10n, org)}'
                : '${org['slug']}',
          ),
          if (domain != null)
            Text(domain, key: ValueKey('domain-${org['id']}')),
        ],
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
                              resellerId: org['resellerId'] is String
                                  ? org['resellerId'] as String
                                  : null,
                            ),
                          );
                      // S9-05: a visit starts at the tenant's home.
                      context.go('/dashboard');
                    },
              child: Text(context.l10n.orgActAs),
            ),
          if (canEdit || canSuspend || !isReseller)
            PopupMenuButton<String>(
              tooltip: context.l10n.orgMore,
              onSelected: (choice) =>
                  orgAction(context, ref, org, isReseller, choice),
              itemBuilder: (_) => [
                if (canEdit)
                  PopupMenuItem(
                    value: 'edit',
                    child: Text(context.l10n.commonEdit),
                  ),
                if (!isReseller)
                  PopupMenuItem(
                    value: 'people',
                    child: Text(context.l10n.navPeople),
                  ),
                if (canSuspend && !deleting)
                  PopupMenuItem(
                    value: 'suspend',
                    child: Text(
                      suspended
                          ? context.l10n.orgResume
                          : context.l10n.orgSuspend,
                    ),
                  ),
                // S1-16 (G-11): deleting, after 30 days; or calling it off.
                if (canEdit && !deleting)
                  PopupMenuItem(
                    value: 'delete',
                    child: Text(context.l10n.orgDelete),
                  ),
                if (canEdit && deleting)
                  PopupMenuItem(
                    value: 'cancel-deletion',
                    child: Text(context.l10n.orgCancelDeletion),
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

/// Edit, suspend or resume, or open the people of one org: what the row menu
/// and a reseller's own page both offer.
Future<void> orgAction(
  BuildContext context,
  WidgetRef ref,
  Json org,
  bool isReseller,
  String choice,
) async {
  final api = ref.read(orgsApiProvider);
  if (api == null) return;
  final id = '${org['id']}';
  void refresh() {
    ref.invalidate(resellersProvider);
    ref.invalidate(tenantsProvider);
  }

  if (choice == 'people') {
    // A tenant's people are managed from inside the tenant, like the rest.
    ref
        .read(actingProvider.notifier)
        .enter(ActingTenant(id: id, name: '${org['name']}'));
    context.go('/users');
    return;
  }

  if (choice == 'edit') {
    final saved = await showDialog<Json>(
      context: context,
      builder: (_) => ResourceFormDialog(
        def: isReseller ? resellerDef : tenantDef,
        row: org,
        save: (_, body) => api.update(reseller: isReseller, id: id, body: body),
      ),
    );
    if (saved != null) refresh();
    return;
  }

  if (choice == 'delete' || choice == 'cancel-deletion') {
    final messenger = ScaffoldMessenger.of(context);
    final name = '${org['name']}';
    if (choice == 'delete') {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (_) => _DeleteOrgDialog(org: org),
      );
      if (confirmed != true) return;
    }
    try {
      if (choice == 'delete') {
        final updated = await api.requestDeletion(reseller: isReseller, id: id);
        showToast(
          messenger,
          currentL10n.orgDeleteRequested(
            name,
            formatDate(updated['deleteAfter']),
          ),
        );
      } else {
        await api.cancelDeletion(reseller: isReseller, id: id);
        showToast(messenger, currentL10n.orgDeletionCancelled(name));
      }
      refresh();
    } catch (e) {
      showToast(messenger, problemMessage(e));
    }
    return;
  }

  final suspend = org['status'] == 'active';
  final messenger = ScaffoldMessenger.of(context);
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(
        suspend
            ? context.l10n.orgSuspendTitle('${org['name']}')
            : context.l10n.orgResumeTitle('${org['name']}'),
      ),
      content: Text(
        suspend ? context.l10n.orgSuspendBody : context.l10n.orgResumeBody,
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(context.l10n.commonCancel),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: Text(
            suspend ? context.l10n.orgSuspend : context.l10n.orgResume,
          ),
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

/// An org's status, in words: suspended, or when it will be deleted (S1-16).
String orgStatusText(AppLocalizations l10n, Json org) =>
    org['status'] == 'pending_deletion'
    ? l10n.orgStatusDeleting(formatDate(org['deleteAfter']))
    : l10n.orgStatusSuspended;

/// S1-16 (G-11): what deleting does, and a typed confirmation, since it cannot
/// be undone after the 30 days.
class _DeleteOrgDialog extends StatefulWidget {
  const _DeleteOrgDialog({required this.org});

  final Json org;

  @override
  State<_DeleteOrgDialog> createState() => _DeleteOrgDialogState();
}

class _DeleteOrgDialogState extends State<_DeleteOrgDialog> {
  final _typed = TextEditingController();

  @override
  void dispose() {
    _typed.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final slug = '${widget.org['slug']}';
    final matches = _typed.text.trim() == slug;
    return AlertDialog(
      title: Text(l10n.orgDeleteTitle('${widget.org['name']}')),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.orgDeleteBody),
            const SizedBox(height: 16),
            TextField(
              key: const ValueKey('org-delete-confirm'),
              controller: _typed,
              autofocus: true,
              decoration: InputDecoration(
                labelText: l10n.orgDeleteConfirmField(slug),
              ),
              onChanged: (_) => setState(() {}),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(l10n.commonCancel),
        ),
        FilledButton(
          key: const ValueKey('org-delete-button'),
          style: FilledButton.styleFrom(
            backgroundColor: Theme.of(context).colorScheme.error,
            foregroundColor: Theme.of(context).colorScheme.onError,
          ),
          onPressed: matches ? () => Navigator.of(context).pop(true) : null,
          child: Text(l10n.orgDeleteButton),
        ),
      ],
    );
  }
}
