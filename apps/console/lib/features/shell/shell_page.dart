import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/session_brand.dart';
import '../../core/acting.dart';
import '../../core/api_client.dart';
import '../../core/locale.dart';
import '../../core/permissions.dart';
import '../../core/session.dart';
import '../../l10n/l10n.dart';
import '../../widgets/brand_header.dart';
import '../../widgets/feedback.dart';
import '../myphone/my_phone_api.dart';
import '../orgs/orgs_api.dart';
import '../pbx/pbx_api.dart';
import 'sections.dart';

/// Below this width the navigation folds into a drawer behind a menu button.
const _narrow = 720.0;

/// The signed-in frame (08 §3, S9-05): the brand and who is signed in across
/// the top, the navigation grouped by area down the side (a drawer on a small
/// screen), and the page. Narrowed to what the user's permissions allow.
class ShellPage extends ConsumerStatefulWidget {
  const ShellPage({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<ShellPage> createState() => _ShellPageState();
}

class _ShellPageState extends ConsumerState<ShellPage> {
  String? _location;

  /// A note about the last page ("Saved.") is not about the next one, and
  /// would sit over it: going to another page dismisses it (S9-03).
  void _dismissToastOnPageChange(String location) {
    if (_location != null && _location != location) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final messenger = ScaffoldMessenger.maybeOf(context);
        messenger?.hideCurrentSnackBar();
        // A note meant for this page ("Maria Lopez added.").
        final note = takeNextPageNote();
        if (note != null && messenger != null) showToast(messenger, note);
      });
    }
    _location = location;
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final brand = ref.watch(effectiveBrandProvider);
    final acting = ref.watch(actingProvider);
    final hasPhone = ref.watch(myExtensionProvider).asData?.value != null;
    final sections = session == null
        ? const <Section>[]
        : visibleSections(
            session,
            acting,
            ref.watch(knownPermissionsProvider),
            hasPhone,
          );
    final location = GoRouterState.of(context).uri.path;
    _dismissToastOnPageChange(location);
    final selected = sections.indexWhere((s) => location.startsWith(s.path));
    final narrow = MediaQuery.sizeOf(context).width < _narrow;

    Widget nav({required bool inDrawer}) => AppNavigation(
      sections: sections,
      selected: selected,
      onSelect: (s) {
        if (inDrawer) Navigator.of(context).pop();
        context.go(s.path);
      },
    );

    return Scaffold(
      appBar: AppBar(
        title: BrandHeader(brand: brand),
        automaticallyImplyLeading: false,
        leading: narrow
            ? Builder(
                builder: (context) => IconButton(
                  tooltip: context.l10n.shellMenu,
                  icon: const Icon(Icons.menu),
                  onPressed: () => Scaffold.of(context).openDrawer(),
                ),
              )
            : null,
        actions: const [_AccountMenu(), SizedBox(width: 8)],
      ),
      drawer: narrow ? Drawer(width: 280, child: nav(inDrawer: true)) : null,
      body: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (!narrow) ...[
            nav(inDrawer: false),
            const VerticalDivider(width: 1),
          ],
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
                Expanded(child: widget.child),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The sections, under their group headings (S9-05). Built from list tiles
/// rather than a navigation drawer's fixed-width rows, so a long label (or a
/// longer language) shortens with an ellipsis instead of overflowing.
class AppNavigation extends StatelessWidget {
  const AppNavigation({
    super.key,
    required this.sections,
    required this.selected,
    required this.onSelect,
  });

  final List<Section> sections;
  final int selected;
  final void Function(Section) onSelect;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final children = <Widget>[const SizedBox(height: 8)];
    NavGroup? current;
    for (final (i, s) in sections.indexed) {
      if (s.group != null && s.group != current) {
        children.add(
          Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(24, 12, 16, 2),
            child: Text(
              s.group!.of(l10n),
              style: theme.textTheme.labelMedium?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
          ),
        );
      }
      current = s.group;
      children.add(
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 1),
          child: ListTile(
            dense: true,
            visualDensity: VisualDensity.compact,
            selected: i == selected,
            selectedColor: scheme.onSecondaryContainer,
            selectedTileColor: scheme.secondaryContainer,
            shape: const StadiumBorder(),
            leading: Icon(s.icon),
            title: Text(
              s.label.of(l10n),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            onTap: () => onSelect(s),
          ),
        ),
      );
    }
    children.add(const SizedBox(height: 8));
    return SizedBox(
      width: 264,
      child: Material(
        color: scheme.surface,
        // Every entry built, not lazily: there are at most a couple of dozen.
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: children,
          ),
        ),
      ),
    );
  }
}

/// Who is signed in, and where: their name on a button that opens their
/// account menu (password, language, support, sign out).
class _AccountMenu extends ConsumerWidget {
  const _AccountMenu();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final session = ref.watch(sessionProvider);
    final me = ref.watch(meProvider).asData?.value;
    final brand = ref.watch(effectiveBrandProvider);
    final locale = ref.watch(localeProvider);
    final name = me?.displayName ?? me?.email;
    final role = switch (session?.orgType) {
      OrgType.master => l10n.shellOrgTypeMaster,
      OrgType.reseller => l10n.shellOrgTypeReseller,
      _ => l10n.shellOrgTypeTenant,
    };
    final where = me?.orgName == null ? role : '${me!.orgName} · $role';
    final initials = (name ?? '?')
        .split(RegExp(r'[\s@.]+'))
        .where((w) => w.isNotEmpty)
        .take(2)
        .map((w) => w.characters.first.toUpperCase())
        .join();
    final wide = MediaQuery.sizeOf(context).width >= _narrow;

    return MenuAnchor(
      alignmentOffset: const Offset(0, 4),
      builder: (context, controller, _) => Tooltip(
        message: l10n.shellAccount,
        child: InkWell(
          key: const ValueKey('account-menu'),
          borderRadius: BorderRadius.circular(24),
          onTap: () =>
              controller.isOpen ? controller.close() : controller.open(),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                CircleAvatar(radius: 16, child: Text(initials)),
                if (wide) ...[
                  const SizedBox(width: 8),
                  Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (name != null)
                        Text(name, style: theme.textTheme.labelLarge),
                      Text(where, style: theme.textTheme.bodySmall),
                    ],
                  ),
                  const Icon(Icons.arrow_drop_down),
                ],
              ],
            ),
          ),
        ),
      ),
      menuChildren: [
        if (name != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name, style: theme.textTheme.titleSmall),
                if (me?.email != null && me!.email != name) Text(me.email!),
                Text(where, style: theme.textTheme.bodySmall),
              ],
            ),
          ),
        if (me?.email != null)
          MenuItemButton(
            leadingIcon: const Icon(Icons.password),
            onPressed: () => _sendPasswordLink(context, ref, me!.email!),
            child: Text(l10n.shellChangePassword),
          ),
        SubmenuButton(
          leadingIcon: const Icon(Icons.translate),
          menuChildren: [
            for (final option in AppLocalizations.supportedLocales)
              MenuItemButton(
                trailingIcon:
                    (locale ?? Localizations.localeOf(context)) == option
                    ? const Icon(Icons.check)
                    : null,
                onPressed: () =>
                    ref.read(localeProvider.notifier).choose(option),
                child: Text(lookupAppLocalizations(option).languageName),
              ),
          ],
          child: Text(l10n.shellLanguage),
        ),
        if (brand.supportEmail != null)
          MenuItemButton(
            leadingIcon: const Icon(Icons.support_agent),
            onPressed: () =>
                launchUrl(Uri(scheme: 'mailto', path: brand.supportEmail)),
            child: Text(l10n.shellContactSupport),
          ),
        const Divider(height: 1),
        MenuItemButton(
          leadingIcon: const Icon(Icons.logout),
          onPressed: () => ref.read(sessionProvider.notifier).signOut(),
          child: Text(l10n.shellSignOut),
        ),
      ],
    );
  }

  /// Emails the person a link to choose a new password: the same flow as
  /// "Forgot your password?", which signs them out everywhere once used.
  Future<void> _sendPasswordLink(
    BuildContext context,
    WidgetRef ref,
    String email,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    final session = ref.read(sessionProvider);
    try {
      await ref
          .read(apiProvider)
          .dio
          .post<Object?>(
            '/v1/auth/password-reset',
            data: {'orgId': ?session?.orgId, 'email': email},
          );
      showToast(messenger, currentL10n.shellPasswordLinkSent(email));
    } catch (e) {
      showToast(messenger, problemMessage(e));
    }
  }
}

/// Shown on every page while a master or reseller user is inside a tenant,
/// with a way to another of the same reseller's tenants, and out.
class _ActingBanner extends StatelessWidget {
  const _ActingBanner({required this.tenant, required this.onExit});

  final ActingTenant tenant;
  final VoidCallback onExit;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
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
                l10n.shellActingAs(
                  tenant.name.isEmpty ? l10n.shellLoading : tenant.name,
                ),
                style: TextStyle(color: scheme.onSecondaryContainer),
              ),
            ),
            TextButton(
              onPressed: () => showDialog<void>(
                context: context,
                builder: (_) => _TenantSwitcher(current: tenant),
              ),
              child: Text(l10n.shellActingSwitch),
            ),
            TextButton(onPressed: onExit, child: Text(l10n.shellActingExit)),
          ],
        ),
      ),
    );
  }
}

/// The other tenants of the same reseller, searchable; picking one moves the
/// visit there, to its home.
class _TenantSwitcher extends ConsumerStatefulWidget {
  const _TenantSwitcher({required this.current});

  final ActingTenant current;

  @override
  ConsumerState<_TenantSwitcher> createState() => _TenantSwitcherState();
}

class _TenantSwitcherState extends ConsumerState<_TenantSwitcher> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final session = ref.watch(sessionProvider);
    final reseller = session?.orgType == OrgType.reseller
        ? session!.orgId
        : widget.current.resellerId;
    final tenants = reseller == null
        ? const AsyncValue<List<Json>>.data([])
        : ref.watch(tenantsProvider(reseller));
    return AlertDialog(
      title: Text(l10n.shellSwitchTitle),
      content: SizedBox(
        width: 420,
        height: 420,
        child: Column(
          children: [
            TextField(
              autofocus: true,
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search),
                hintText: l10n.shellSwitchSearch,
              ),
              onChanged: (v) => setState(() => _query = v.toLowerCase()),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: tenants.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (e, _) => Center(child: Text(problemMessage(e))),
                data: (rows) {
                  final others = [
                    for (final r in rows)
                      if (r['id'] != widget.current.id &&
                          r['status'] != 'suspended' &&
                          '${r['name']}'.toLowerCase().contains(_query))
                        r,
                  ];
                  if (others.isEmpty) {
                    return Center(child: Text(l10n.shellSwitchNone));
                  }
                  return ListView(
                    children: [
                      for (final r in others)
                        ListTile(
                          leading: const Icon(Icons.apartment_outlined),
                          title: Text('${r['name']}'),
                          onTap: () {
                            ref
                                .read(actingProvider.notifier)
                                .enter(
                                  ActingTenant(
                                    id: '${r['id']}',
                                    name: '${r['name']}',
                                    resellerId: reseller,
                                  ),
                                );
                            Navigator.of(context).pop();
                            context.go('/dashboard');
                          },
                        ),
                    ],
                  );
                },
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.commonCancel),
        ),
      ],
    );
  }
}

/// The page for a section with no screen of its own yet.
class SectionPage extends StatelessWidget {
  const SectionPage({super.key, required this.section});

  final Section section;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Align(
        alignment: AlignmentDirectional.topStart,
        child: Text(
          section.label.of(context.l10n),
          style: Theme.of(context).textTheme.headlineSmall,
        ),
      ),
    );
  }
}
